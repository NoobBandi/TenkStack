// Package quant turns a model published in bf16 into a smaller one on
// disk, the way llama-quantize does for GGUF, for the runtimes that read
// safetensors. auto-round can write GGUF too, but its bundled converter
// refused Qwen3 and its own docs say not to tune for that format, so GGUF
// stays with llama.cpp's tools and the quants publishers already ship.
//
// The tool is Intel's auto-round, run in a container derived from the vLLM
// image the store installed: that image has the XPU torch the tuning needs,
// and auto-round is one wheel on top. The derived image is built here on
// first use and rebuilt when its base changes. One job runs at a time, on
// the card the user picked, and writes a new directory beside the source
// with the scheme's suffix, so the result appears in the file list like a
// download would.
package quant

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
	"github.com/NoobBandi/TenkStack/server-go/internal/providers"
	"github.com/NoobBandi/TenkStack/server-go/internal/vendors"
)

// The wheel is pinned: its command line and output layout are what this
// package parses, and a rolling install would move under it. The recipe
// number is part of the image tag, so a change here builds a new image
// rather than trusting one built from the old Dockerfile.
const (
	autoRoundVersion = "0.15.1"
	recipe           = "2"
)

// Scheme is one thing the tool can be asked to make.
type Scheme struct {
	Key    string
	Label  string
	Family string // safetensors or gguf
	// Suffix is appended to the source directory's name for the output.
	Suffix string
	Args   []string
	// Shrink is the weights' size against bf16, for the estimate.
	Shrink float64
	// Tuned means the scheme runs auto-round's optimisation, which is where
	// the time goes and where the speed setting applies.
	Tuned bool
	Note  string
}

// Schemes are what the form offers. Each was run on this machine and its
// output loaded by the Intel vLLM build; a scheme that only the docs say
// works does not belong here. Int8 was tried and refused by that build's
// kernels, and FP8 is the same size with nothing lost.
var Schemes = []Scheme{
	// Per-tensor FP8 with static activation scales: the one FP8 layout the
	// Intel kernel takes through compressed-tensors (block FP8, Qwen's own
	// layout, is refused there). Without tuning it is one calibration pass,
	// a couple of minutes; tuned, it is an hour for nothing anyone would
	// notice.
	{Key: "fp8", Label: "FP8", Family: "safetensors", Suffix: "FP8", Shrink: 0.58,
		Args: []string{"--scheme", "FP8_STATIC", "--format", "llm_compressor", "--iters", "0", "--disable_opt_rtn"},
		Note: "顯存減半，品質幾乎不變，幾分鐘就好；vLLM 讀"},
	{Key: "int4", Label: "Int4（AutoRound）", Family: "safetensors", Suffix: "W4A16-AutoRound", Shrink: 0.28, Tuned: true,
		Args: []string{"--scheme", "W4A16", "--format", "auto_round"},
		Note: "顯存四分之一，速度跟原精度差不多；經校準資料調過，比線上 Int4 準；vLLM 讀"},
}

func SchemeOf(key string) *Scheme {
	for i := range Schemes {
		if Schemes[i].Key == key {
			return &Schemes[i]
		}
	}
	return nil
}

// Speeds are how hard a tuned scheme tries. The numbers are auto-round's
// own recipes: the default, the "light" one, and none at all.
var Speeds = map[string][]string{
	"standard": {"--iters", "200", "--nsamples", "128"},
	"fast":     {"--iters", "50", "--nsamples", "128"},
	"rtn":      {"--iters", "0", "--disable_opt_rtn"},
}

// Images is what this needs from docker.
type Images interface {
	ImageID(ctx context.Context, image string) string
}

// Weights is what this needs from the model locations: what is there, and
// where a name is on disk with the root of its location.
type Weights interface {
	ListWeights() []api.GGUFFile
	Place(name string) (abs, root string, ok bool)
}

type Manager struct {
	Docker Images
	Models Weights
	// WorkDir holds the derived image's build context and the container's
	// home: the calibration set and the compile cache, kept between jobs.
	WorkDir string
	// Cards names the host's cards for the selector.
	Cards func(ctx context.Context) []vendors.Card

	mu    sync.Mutex
	tools map[string]*api.QuantTool
	jobs  []*api.QuantJob
	// cancel stops the running job's container.
	cancel context.CancelFunc
	seq    int
}

func New(docker Images, models Weights, workDir string, cards func(context.Context) []vendors.Card) *Manager {
	return &Manager{Docker: docker, Models: models, WorkDir: workDir, Cards: cards,
		tools: map[string]*api.QuantTool{}}
}

// Invalid is a request that cannot be carried out, worth a 400.
type Invalid struct{ Msg string }

func (e *Invalid) Error() string { return e.Msg }

// base is the vLLM build the tool image derives from, for one vendor.
func base(vendor string) (providers.Build, bool) {
	p := providers.Get(providers.VLLM)
	if p == nil {
		return providers.Build{}, false
	}
	b, ok := p.Builds[vendor]
	return b, ok
}

func short(id string) string {
	id = strings.TrimPrefix(id, "sha256:")
	if len(id) > 12 {
		id = id[:12]
	}
	return id
}

// Tool is the derived image for one vendor and whether it exists: built
// from the vLLM image that is here, so it is missing until vLLM is
// installed and stale when vLLM was updated.
func (m *Manager) Tool(ctx context.Context, vendor string) api.QuantTool {
	b, ok := base(vendor)
	if !ok {
		return api.QuantTool{Vendor: vendor, State: "unsupported"}
	}
	baseID := m.Docker.ImageID(ctx, b.Image)
	m.mu.Lock()
	if t, ok := m.tools[vendor]; ok && (t.State == "building") {
		copy := *t
		m.mu.Unlock()
		return copy
	}
	m.mu.Unlock()
	t := api.QuantTool{Vendor: vendor, Base: b.Image, State: "absent"}
	if baseID == "" {
		t.State = "no-base"
		return t
	}
	t.Image = fmt.Sprintf("tenkstack/quant-%s:%s-r%s", vendor, short(baseID), recipe)
	if m.Docker.ImageID(ctx, t.Image) != "" {
		t.State = "ready"
	}
	m.mu.Lock()
	if prev, ok := m.tools[vendor]; ok && prev.State == "error" && prev.Image == t.Image {
		t.State, t.Message = "error", prev.Message
	}
	m.mu.Unlock()
	return t
}

// Build makes the derived image in the background. auto-round is one
// wheel; --no-deps keeps pip from replacing the image's own torch and
// oneCCL with ones that do not know the card.
func (m *Manager) Build(ctx context.Context, vendor string) (api.QuantTool, error) {
	t := m.Tool(ctx, vendor)
	switch t.State {
	case "unsupported":
		return t, &Invalid{"vLLM 沒有 " + vendor + " 顯示卡的版本，量化工具建立不了"}
	case "no-base":
		return t, &Invalid{"先到商店安裝 vLLM，量化工具是從它的映像建出來的"}
	case "ready", "building":
		return t, nil
	}
	dir := filepath.Join(m.WorkDir, "build-"+vendor)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return t, err
	}
	// gguf is the writer for the GGUF schemes; auto-round imports it only
	// then, so it is not among its declared dependencies.
	dockerfile := fmt.Sprintf(`FROM %s
RUN pip install --no-deps --no-cache-dir auto-round==%s gguf
ENTRYPOINT ["bash", "-c", "source /opt/intel/oneapi/setvars.sh --force >/dev/null 2>&1 || true; exec auto-round \"$@\"", "--"]
`, t.Base, autoRoundVersion)
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte(dockerfile), 0o644); err != nil {
		return t, err
	}
	t.State, t.Message = "building", ""
	rec := t
	m.mu.Lock()
	m.tools[vendor] = &rec
	m.mu.Unlock()
	go func() {
		cmd := exec.Command("docker", "build", "-t", rec.Image, dir)
		out, err := cmd.CombinedOutput()
		m.mu.Lock()
		defer m.mu.Unlock()
		if err != nil {
			tail := out
			if len(tail) > 2000 {
				tail = tail[len(tail)-2000:]
			}
			rec.State, rec.Message = "error", strings.TrimSpace(string(tail))
			log.Printf("could not build %s: %v", rec.Image, err)
			return
		}
		rec.State = "ready"
		log.Printf("built %s", rec.Image)
	}()
	return rec, nil
}

// Request is what a job is asked to do.
type Request struct {
	Source string
	Scheme string
	Speed  string
	// Card is the host's index of the card to tune on.
	Card int
}

var name = regexp.MustCompile(`[^A-Za-z0-9._-]`)

// Output is where a scheme's result goes: beside the source, named after
// it, the way publishers name their own quantised repos -- and so in the
// source's location, which is the one disk the job has to write to.
func Output(source string, s Scheme) string {
	return source + "-" + s.Suffix
}

// Start runs one job in the background. The source must be a bf16
// directory that exists, the scheme known, the card one of this vendor's,
// and nothing else may be running: the card is the bottleneck.
func (m *Manager) Start(ctx context.Context, req Request) (api.QuantJob, error) {
	s := SchemeOf(req.Scheme)
	if s == nil {
		return api.QuantJob{}, &Invalid{"不認識的量化方式：" + req.Scheme}
	}
	speed := req.Speed
	if speed == "" {
		speed = "standard"
	}
	if _, ok := Speeds[speed]; !ok {
		return api.QuantJob{}, &Invalid{"不認識的速度設定：" + speed}
	}
	var source *api.GGUFFile
	for _, f := range m.Models.ListWeights() {
		if f.Filename == req.Source && f.Format == "safetensors" {
			f := f
			source = &f
		}
	}
	if source == nil {
		return api.QuantJob{}, &Invalid{"模型目錄裡沒有這個 safetensors 資料夾"}
	}
	if source.Quantized {
		return api.QuantJob{}, &Invalid{"這個模型已經量化過了（" + source.Precision + "），要從原精度的版本量"}
	}
	cards := m.Cards(ctx)
	if req.Card < 0 || req.Card >= len(cards) {
		return api.QuantJob{}, &Invalid{"沒有這張卡"}
	}
	card := cards[req.Card]
	tool := m.Tool(ctx, card.Vendor)
	if tool.State != "ready" {
		return api.QuantJob{}, &Invalid{"量化工具還沒準備好（" + tool.State + "），先建立它"}
	}
	output := Output(req.Source, *s)
	target, _, ok := m.Models.Place(output)
	if !ok {
		return api.QuantJob{}, &Invalid{"輸出路徑不在模型位置裡：" + output}
	}
	if _, err := os.Stat(target); err == nil {
		return api.QuantJob{}, &Invalid{output + " 已經存在"}
	}
	m.mu.Lock()
	for _, j := range m.jobs {
		if j.State == "running" || j.State == "queued" {
			m.mu.Unlock()
			return api.QuantJob{}, &Invalid{"已經有一個量化在跑：" + j.Source + " → " + j.Output}
		}
	}
	m.seq++
	job := &api.QuantJob{
		ID: strconv.Itoa(m.seq), Source: req.Source, Output: output, Scheme: s.Key, Family: s.Family,
		Speed: speed, Card: req.Card, State: "running", StartedAt: time.Now().Unix(),
		SourceBytes: source.SizeBytes, Log: []string{},
	}
	m.jobs = append(m.jobs, job)
	runCtx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.mu.Unlock()

	go m.run(runCtx, job, *s, speed, card, cards, tool.Image)
	return *job, nil
}

// Progress lines: "Quantizing model.layers.12:  33%|███  | 12/36 [..]".
var progress = regexp.MustCompile(`Quantizing [^:]*:\s+\d+%\|[^|]*\|\s*(\d+)/(\d+)`)

func (m *Manager) run(ctx context.Context, job *api.QuantJob, s Scheme, speed string, card vendors.Card, cards []vendors.Card, image string) {
	home := filepath.Join(m.WorkDir, "home")
	os.MkdirAll(home, 0o755)
	v := vendors.Get(card.Vendor)
	// The source's location is mounted writable, at its own path so the
	// tool's config.json records nothing that is only true inside. The
	// container runs as this user: files root left behind could not be
	// deleted from the file list.
	args := []string{"run", "--rm", "--init", "--name", "tenkstack-quant",
		"--user", fmt.Sprintf("%d:%d", os.Getuid(), os.Getgid())}
	// Running as this user means not being in the groups that own the
	// device nodes; the container is given them by number.
	for _, node := range []string{"/dev/dri/renderD128", "/dev/dri/card0", "/dev/kfd"} {
		if gid, ok := groupOf(node); ok {
			args = append(args, "--group-add", strconv.Itoa(gid))
		}
	}
	// The tool writes scratch under the working directory, so that is the
	// mounted one rather than the image's root-owned checkout.
	src, root, _ := m.Models.Place(job.Source)
	out, _, _ := m.Models.Place(job.Output)
	args = append(args, "--workdir", "/work",
		"-e", "HOME=/work", "-e", "HF_HOME=/work/hf", "-e", "TORCHINDUCTOR_CACHE_DIR=/work/inductor",
		"-v", home+":/work",
		"-v", root+":"+root,
		"--shm-size", "16g", "--network", "host")
	if v != nil {
		// Every card of the vendor goes in; the selector picks one, by the
		// index the backend gives it, which for one vendor's cards is the
		// position among them.
		args = append(args, v.DeviceFlags(vendors.Card{}, nil)...)
		if strings.Contains(strings.Join(args, " "), "/dev/dri") {
			args = append(args, "-v", "/dev/dri/by-path:/dev/dri/by-path:ro")
		}
		ordinal := 0
		for _, c := range cards {
			if c.PCIBDFAddress == card.PCIBDFAddress {
				break
			}
			if c.Vendor == card.Vendor {
				ordinal++
			}
		}
		if v.SelectorVar != "" {
			args = append(args, "-e", v.SelectorVar+"="+v.Selector(strconv.Itoa(ordinal)))
		}
	}
	// --gpus all from the NVIDIA record is a docker run flag like the rest.
	for i := range args {
		if args[i] == "--gpus" && i+1 < len(args) && strings.HasPrefix(args[i+1], "device=") {
			args[i+1] = "all"
		}
	}
	args = append(args, image, "--model", src, "--output_dir", out, "--device", deviceArg[card.Vendor])
	args = append(args, s.Args...)
	if s.Tuned {
		args = append(args, Speeds[speed]...)
	}
	// Above a size the card cannot hold whole, auto-round streams blocks
	// through it, slower but possible; the estimate is bf16 plus room.
	if job.SourceBytes > 20<<30 {
		args = append(args, "--low_gpu_mem_usage")
	}
	log.Printf("quantizing %s -> %s (%s, %s) on %s", job.Source, job.Output, s.Key, speed, card.PCIBDFAddress)

	cmd := exec.CommandContext(ctx, "docker", args...)
	cmd.Cancel = func() error {
		// The signal has to reach the container; killing the client leaves
		// it running.
		exec.Command("docker", "stop", "-t", "5", "tenkstack-quant").Run()
		return cmd.Process.Kill()
	}
	pipe, err := cmd.StdoutPipe()
	cmd.Stderr = cmd.Stdout
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		m.finish(job, "error", err.Error())
		return
	}
	scanner := bufio.NewScanner(pipe)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	// tqdm redraws with \r; each redraw is a line here.
	scanner.Split(func(data []byte, atEOF bool) (int, []byte, error) {
		for i, b := range data {
			if b == '\n' || b == '\r' {
				return i + 1, data[:i], nil
			}
		}
		if atEOF && len(data) > 0 {
			return len(data), data, nil
		}
		return 0, nil, nil
	})
	for scanner.Scan() {
		line := strings.TrimSpace(stripANSI(scanner.Text()))
		if line == "" {
			continue
		}
		m.mu.Lock()
		if mm := progress.FindStringSubmatch(line); mm != nil {
			done, _ := strconv.Atoi(mm[1])
			total, _ := strconv.Atoi(mm[2])
			job.BlocksDone, job.BlocksTotal = done, total
		} else if !strings.Contains(line, "it/s]") && !strings.Contains(line, "s/it]") {
			job.Log = append(job.Log, line)
			if len(job.Log) > 40 {
				job.Log = job.Log[len(job.Log)-40:]
			}
		}
		job.Message = line
		m.mu.Unlock()
	}
	err = cmd.Wait()
	if ctx.Err() != nil {
		os.RemoveAll(out)
		m.finish(job, "cancelled", "已取消，輸出資料夾已清掉")
		return
	}
	if err != nil {
		os.RemoveAll(out)
		m.finish(job, "error", "量化失敗，看下面的記錄；輸出資料夾已清掉")
		return
	}
	// auto-round nests the result one directory down, under a name of its
	// own; lifted so the output is the directory that was asked for, which
	// the file list reads as one model.
	flatten(out)
	job.BlocksDone = job.BlocksTotal
	m.finish(job, "done", "")
}

// flatten moves a lone subdirectory's contents up into dir.
func flatten(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 || !entries[0].IsDir() {
		return
	}
	inner := filepath.Join(dir, entries[0].Name())
	files, err := os.ReadDir(inner)
	if err != nil {
		return
	}
	for _, f := range files {
		if err := os.Rename(filepath.Join(inner, f.Name()), filepath.Join(dir, f.Name())); err != nil {
			log.Printf("could not lift %s out of %s: %v", f.Name(), inner, err)
			return
		}
	}
	os.Remove(inner)
}

func (m *Manager) finish(job *api.QuantJob, state, message string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	job.State = state
	if message != "" {
		job.Message = message
	}
	job.FinishedAt = time.Now().Unix()
	m.cancel = nil
	log.Printf("quantization %s: %s", job.Output, state)
}

// Cancel stops the running job, if there is one.
func (m *Manager) Cancel(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, j := range m.jobs {
		if j.ID == id && j.State == "running" && m.cancel != nil {
			m.cancel()
			return true
		}
	}
	return false
}

// Jobs is every job this process has run, newest first.
func (m *Manager) Jobs() []api.QuantJob {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]api.QuantJob, 0, len(m.jobs))
	for i := len(m.jobs) - 1; i >= 0; i-- {
		j := *m.jobs[i]
		j.Log = append([]string{}, m.jobs[i].Log...)
		out = append(out, j)
	}
	return out
}

// deviceArg is what auto-round calls the vendor's accelerator; the
// selector outside has already narrowed it to one card.
var deviceArg = map[string]string{"intel": "xpu", "nvidia": "0", "amd": "0"}

// groupOf is the group that owns a device node, so the container's user
// can be added to it.
func groupOf(node string) (int, bool) {
	st, err := os.Stat(node)
	if err != nil {
		return 0, false
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); ok {
		return int(sys.Gid), true
	}
	return 0, false
}

var ansi = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)

func stripANSI(s string) string { return ansi.ReplaceAllString(s, "") }

// Options is the schemes as the API lists them.
func Options() []api.QuantScheme {
	out := make([]api.QuantScheme, 0, len(Schemes))
	for _, s := range Schemes {
		out = append(out, api.QuantScheme{Key: s.Key, Label: s.Label, Family: s.Family, Suffix: s.Suffix,
			Shrink: s.Shrink, Tuned: s.Tuned, Note: s.Note})
	}
	return out
}

// SafeName says whether an output name would stay inside the models
// directory; a source that reached the list already does.
func SafeName(n string) bool {
	return n != "" && !strings.Contains(n, "..") && !strings.HasPrefix(n, "/") && name.ReplaceAllString(path.Base(n), "") != ""
}
