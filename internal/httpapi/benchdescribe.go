package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/NoobBandi/TenkStack/internal/bench"
	"github.com/NoobBandi/TenkStack/internal/gguf"
	"github.com/NoobBandi/TenkStack/internal/gpu"
	"github.com/NoobBandi/TenkStack/internal/llamaswap"
	"github.com/NoobBandi/TenkStack/internal/locations"
	"github.com/NoobBandi/TenkStack/internal/profile"
	"github.com/NoobBandi/TenkStack/internal/providers"
	"github.com/NoobBandi/TenkStack/internal/schema"
	"github.com/NoobBandi/TenkStack/internal/tuning"
)

// BenchDescriber is the console's bench.Describer: it gathers what the
// console knows -- llama-swap's entry, the cards, /proc, the engine
// registry, the launcher script, docker -- and lets internal/profile name
// it the way a run records it. Every source is optional; a Server missing one
// (as in tests) leaves those fields empty rather than failing the run.
type BenchDescriber struct{ S *Server }

// Describe fills ModelID, Name, Command, Hardware, Model and Engine. Tuning
// and Unrecognized are left for the parameter parser.
// launch is a model's entry in llama-swap's config as the profile reads
// it: the command and environment, and which engine runs it.
type launch struct {
	name, cmd string
	env       map[string]string
	macros    map[string]string
	args      []string
	launcher  profile.Launcher
	prov      *providers.Provider
	key       string // the engine, as profile names it
	vendor    string
}

func (s *Server) launchOf(modelID string) (launch, error) {
	c, err := s.Config.Load()
	if err != nil {
		return launch{}, err
	}
	var entry *llamaswap.Mapping
	if models := c.Root().Map("models"); models != nil {
		entry = models.Map(modelID)
	}
	if entry == nil {
		return launch{}, fmt.Errorf("找不到模型 %s", modelID)
	}
	l := launch{
		name:   llamaswap.Scalar(entry.Get("name")),
		cmd:    llamaswap.Scalar(entry.Get("cmd")),
		env:    llamaswap.EnvMap(entry.Get("env")),
		macros: llamaswap.Macros(c),
	}
	if l.name == "" {
		l.name = modelID
	}
	l.args = profile.Split(l.cmd)
	l.launcher = profile.LauncherOf(l.args, l.macros)
	registered := ""
	if l.launcher.Macro != "" {
		if p, v, ok := providers.Resolve(l.launcher.Macro); ok {
			l.prov, registered, l.vendor = &p, p.Key, v
		}
	}
	l.key = profile.EngineKey(l.launcher, registered)
	if l.prov == nil {
		// Unclaimed launchers of a registered engine still have its site
		// and variable prefix.
		l.prov = providers.Get(l.key)
	}
	l.vendor = profile.VendorOf(l.launcher, l.vendor)
	return l, nil
}

func (d BenchDescriber) Describe(ctx context.Context, modelID string) (bench.Description, error) {
	s := d.S
	l, err := s.launchOf(modelID)
	if err != nil {
		return bench.Description{}, err
	}
	name, cmd, env, macros, args, launcher, prov, key, vendor :=
		l.name, l.cmd, l.env, l.macros, l.args, l.launcher, l.prov, l.key, l.vendor

	used := profile.CardsUsed(d.cards(ctx), env, args, key, vendor)
	cpu, ram := "", int64(0)
	if s.System != nil {
		sample := s.System.Sample()
		if sample.CPU.Model != nil {
			cpu = *sample.CPU.Model
		}
		ram = sample.Memory.TotalBytes
	}
	engine := d.engine(ctx, modelID, key, launcher, prov, env)
	// The built-in spellings, not the installed llama-server's help: asking
	// a launcher for its help starts a container the first time, and the
	// built-in tables were taken from that help anyway.
	params, unrecognized := tuning.Parse(cmd, env, engine.Key)
	served := 0
	if proxy := d.proxy(ctx, modelID); proxy != "" {
		served = s.LlamaSwap.ServedContext(ctx, proxy)
	}
	// A command that names no context -- Strata's wrapper script, a
	// llama-server left at the model's default -- still has one: the
	// engine's, which the export should carry rather than leave unknown.
	if params.ContextLength == 0 && served > 0 {
		params.ContextLength = served
	}
	return bench.Description{
		ModelID:       modelID,
		Name:          name,
		Command:       cmd,
		Hardware:      profile.Hardware(used, cpu, ram),
		Model:         d.model(profile.ModelArg(args), macros),
		Engine:        engine,
		Tuning:        params,
		Unrecognized:  unrecognized,
		ServedContext: served,
	}, nil
}

// cards is every GPU with what the profile needs of it. A card's ordinal
// in its vendor's selector is taken as its position among that vendor's
// cards in the console's numbering, which follows PCI order as the
// runtimes' own does; only the count and the model of the cards end up in
// the profile, and those do not depend on which of two identical cards is
// which.
func (d BenchDescriber) cards(ctx context.Context) []profile.Card {
	if d.S.Gpu == nil {
		return nil
	}
	var out []profile.Card
	ordinal := map[string]int{}
	for _, dev := range d.S.Gpu.Discover(ctx) {
		c := profile.Card{Vendor: dev.Vendor, Name: deref(dev.Name), Ordinal: ordinal[dev.Vendor]}
		ordinal[dev.Vendor]++
		if live := d.S.Gpu.Sample(ctx, dev.Index); live != nil && live.MemoryTotalMiB != nil {
			c.VRAMMiB = int(*live.MemoryTotalMiB + 0.5)
		}
		if link := gpu.PCIeLink("/sys", deref(dev.PCIBDFAddress)); link != nil {
			c.PCIe = link.Link
		}
		out = append(out, c)
	}
	return out
}

// model names the weights, reading what the files say about themselves
// only where the name does not: a safetensors model's config.json, a GGUF
// header when the file name carries no quant tag.
func (d BenchDescriber) model(raw string, macros map[string]string) schema.ModelRef {
	if raw == "" {
		return schema.ModelRef{}
	}
	var locs []locations.Location
	if d.S.Models != nil {
		locs = d.S.Models.Locations()
	}
	abs := ""
	if key, rel, ok := profile.Locate(raw, macros, locs); ok && d.S.Models != nil {
		abs, _, _ = d.S.Models.Place(locations.Ref(key, rel))
	} else if p := profile.Expand(raw, macros); filepath.IsAbs(p) {
		abs = p
	}
	facts := profile.ModelFacts{FileType: -1}
	if strings.HasSuffix(strings.ToLower(raw), ".gguf") {
		if profile.GGUFQuant(raw, -1) == "" && abs != "" {
			facts.FileType = ggufFileType(abs)
		}
	} else if abs != "" {
		if b, err := os.ReadFile(filepath.Join(abs, "config.json")); err == nil {
			facts.Precision = profile.Precision(b)
		}
	}
	return profile.Model(raw, macros, locs, facts)
}

// ggufFileType is general.file_type from a GGUF's header, -1 when the
// header cannot be read.
func ggufFileType(p string) int {
	f, err := os.Open(p)
	if err != nil {
		return -1
	}
	defer f.Close()
	for _, size := range []int{gguf.FirstRead, gguf.WiderRead} {
		buf := make([]byte, size)
		n, _ := f.ReadAt(buf, 0)
		h, err := gguf.Parse(buf[:n])
		if errors.Is(err, gguf.ErrShort) && n == size {
			continue
		}
		if err != nil || h == nil {
			return -1
		}
		switch v := h.Meta["general.file_type"].(type) {
		case uint32:
			return int(v)
		case int32:
			return int(v)
		case uint64:
			return int(v)
		case int64:
			return int(v)
		}
		return -1
	}
	return -1
}

// launcherScriptLimit keeps a native llama-server binary, which is a
// launcher too, from being read whole in search of an IMAGE= line.
const launcherScriptLimit = 256 << 10

// engine names the engine and finds its version: from the engine itself
// when the model is loaded, from the image the launcher runs, from the
// program's --version for a native llama.cpp build, or from the checkout
// a script like Strata's lives in.
func (d BenchDescriber) engine(ctx context.Context, modelID, key string, launcher profile.Launcher, prov *providers.Provider, env map[string]string) schema.EngineRef {
	var f profile.EngineFacts
	prefix := ""
	if prov != nil {
		f.Site, prefix = prov.Site, prov.EnvPrefix
	}
	if st, err := os.Stat(launcher.Path); err == nil && st.Mode().IsRegular() && st.Size() < launcherScriptLimit {
		if b, err := os.ReadFile(launcher.Path); err == nil {
			f.Image = profile.ImageIn(string(b), prefix, env)
		}
	} else if prefix != "" && env[prefix+"_IMAGE"] != "" {
		f.Image = env[prefix+"_IMAGE"]
	}
	if f.Image != "" && d.S.Docker != nil {
		f.Labels, f.RepoDigests = d.inspectImage(ctx, f.Image)
	}
	f.Reported = d.running(ctx, modelID, key)
	if f.Reported == "" && f.Image == "" && launcher.Path != "" {
		switch key {
		case profile.LlamaCpp:
			f.Reported = llamaVersion(ctx, launcher.Path)
		case profile.Strata, profile.Other:
			f.Reported = checkoutVersion(ctx, launcher.Path)
		}
	}
	return profile.Engine(key, f)
}

// inspectImage is an image's labels and repo digests as docker has them.
func (d BenchDescriber) inspectImage(ctx context.Context, image string) (map[string]string, []string) {
	out, ok := d.S.Docker.Command(ctx, "image", "inspect", "--format", "{{json .Config.Labels}}\t{{json .RepoDigests}}", image)
	if !ok {
		return nil, nil
	}
	labels, digests, _ := strings.Cut(strings.TrimSpace(out), "\t")
	var l map[string]string
	var r []string
	_ = json.Unmarshal([]byte(labels), &l)
	_ = json.Unmarshal([]byte(digests), &r)
	return l, r
}

// proxy is where llama-swap reaches a model that is loaded and ready, ""
// when it is not.
func (d BenchDescriber) proxy(ctx context.Context, modelID string) string {
	if d.S.LlamaSwap == nil {
		return ""
	}
	for _, entry := range d.S.LlamaSwap.Running(ctx) {
		if id, _ := entry["model"].(string); id != modelID {
			continue
		}
		proxy, _ := entry["proxy"].(string)
		if state, _ := entry["state"].(string); state != "" && state != "ready" {
			return ""
		}
		return proxy
	}
	return ""
}

// running is the version a loaded model's engine reports: llama-server's
// build_info, vLLM's and SGLang's /version. "" when it is not loaded.
func (d BenchDescriber) running(ctx context.Context, modelID, key string) string {
	proxy := d.proxy(ctx, modelID)
	if proxy == "" {
		return ""
	}
	switch key {
	case profile.LlamaCpp:
		if props := d.S.LlamaSwap.Props(ctx, proxy); props != nil {
			b, _ := props["build_info"].(string)
			return b
		}
	case profile.VLLM, profile.SGLang:
		return serverVersion(ctx, proxy)
	}
	return ""
}

func serverVersion(ctx context.Context, base string) string {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(base, "/")+"/version", nil)
	if err != nil {
		return ""
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	var body struct {
		Version string `json:"version"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&body) != nil {
		return ""
	}
	return body.Version
}

// llamaVersion asks a native llama-server launcher for --version, as the
// versions page does: no model is loaded, though a SYCL launcher takes a
// few seconds to set up oneAPI first.
func llamaVersion(ctx context.Context, launcher string) string {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(ctx, launcher, "--version").CombinedOutput()
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "version:") {
			return line
		}
	}
	return ""
}

// checkoutVersion is the commit of the source checkout a launcher script
// ships in, for an engine run from its own repository (Strata). Only when
// the script sits at the top of that checkout: a script that merely lives
// somewhere inside an unrelated repository -- ~/ai is one -- would
// otherwise report that repository's commit.
func checkoutVersion(ctx context.Context, script string) string {
	dir := filepath.Dir(script)
	if real, err := filepath.EvalSymlinks(dir); err == nil {
		dir = real
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	top, err := exec.CommandContext(ctx, "git", "-C", dir, "rev-parse", "--show-toplevel").Output()
	if err != nil || filepath.Clean(strings.TrimSpace(string(top))) != filepath.Clean(dir) {
		return ""
	}
	out, err := exec.CommandContext(ctx, "git", "-C", dir, "describe", "--always", "--dirty", "--abbrev=7").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
