package comfy

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
	"github.com/NoobBandi/TenkStack/server-go/internal/vendors"
)

// What ComfyUI listens on inside the container: a property of the image.
const inside = 8188

// Docker is what the instance manager needs from the container side.
type Docker interface {
	Names(ctx context.Context) []string
	Command(ctx context.Context, args ...string) (string, bool)
	Inspect(ctx context.Context, names []string) map[string]map[string]any
	Survey(ctx context.Context, cards []vendors.Card) api.Survey
	ImageSizes(ctx context.Context) map[string]string
	Pull(ctx context.Context, image string, progress api.Progress) bool
}

// Publisher writes and removes the Caddy site block for an instance.
type Publisher interface {
	PublishComfy(ctx context.Context, upstream int, note string) (int, error)
	UnpublishComfy(ctx context.Context, upstream int) error
	PublicPort(upstream int) int
}

// Manager creates, rebuilds and removes instances.
type Manager struct {
	Docker    Docker
	Channels  Publisher
	Ports     []int
	ComfyDir  string
	BusKey    func(string) string
	published *regexp.Regexp

	mu      sync.Mutex
	jobs    map[string]*api.Job
	storage map[string]*storageEntry
}

func NewManager(docker Docker, channels Publisher, ports []int, comfyDir string, busKey func(string) string) *Manager {
	return &Manager{Docker: docker, Channels: channels, Ports: ports, ComfyDir: comfyDir, BusKey: busKey,
		published: regexp.MustCompile(`:(\d+)->`), jobs: map[string]*api.Job{}}
}

// Template is ComfyUI's image per vendor: one publisher, so the entrypoint
// and storage layout are identical across cards.
func Template(vendor string) *api.ComfyTemplate {
	v := vendors.Get(vendor)
	if v == nil || v.Comfy == nil {
		return nil
	}
	return &api.ComfyTemplate{Label: v.Label, Image: v.Comfy.Image, Verified: v.Comfy.Verified, Vendor: vendor}
}

// Slot is the short name for the instance on cards[i], in the vendor's
// own naming: comfyui-xpu, comfyui-nv0.
func Slot(cards []vendors.Card, i int) string {
	key := cards[i].Vendor
	if key == "" {
		key = "gpu"
	}
	index := 0
	for j := 0; j < i; j++ {
		k := cards[j].Vendor
		if k == "" {
			k = "gpu"
		}
		if k == key {
			index++
		}
	}
	if v := vendors.Get(key); v != nil {
		return v.Slot(index)
	}
	return fmt.Sprintf("%s%d", key, index)
}

func deviceFlags(card vendors.Card, cards []vendors.Card) []string {
	if v := vendors.Get(card.Vendor); v != nil {
		return v.DeviceFlags(card, cards)
	}
	return nil
}

// Invalid is a request that cannot be carried out, worth a 400.
type Invalid struct{ Msg string }

func (e *Invalid) Error() string { return e.Msg }

func (m *Manager) takenPorts(ctx context.Context, cards []vendors.Card, except string) map[int]bool {
	taken := map[int]bool{}
	for _, c := range m.Docker.Survey(ctx, cards).Containers {
		if c.Name == except {
			continue
		}
		for _, match := range m.published.FindAllStringSubmatch(c.Ports, -1) {
			n, _ := strconv.Atoi(match[1])
			taken[n] = true
		}
	}
	return taken
}

func (m *Manager) volumes(slot string) []string {
	root := m.ComfyDir
	shared := filepath.Join(root, "storage-models")
	user := filepath.Join(root, "storage-user")
	return []string{
		"-v", filepath.Join(shared, "models") + ":/root/ComfyUI/models",
		"-v", filepath.Join(shared, "hf-hub") + ":/root/.cache/huggingface/hub",
		"-v", filepath.Join(shared, "torch-hub") + ":/root/.cache/torch/hub",
		"-v", filepath.Join(user, "input") + ":/root/ComfyUI/input",
		"-v", filepath.Join(user, "output-"+slot) + ":/root/ComfyUI/output",
		"-v", filepath.Join(user, "user-profile") + ":/root/ComfyUI/user",
		"-v", filepath.Join(user, "user-scripts") + ":/root/user-scripts",
		"-v", filepath.Join(root, "storage-"+slot) + ":/root",
	}
}

func (m *Manager) mkdirs(slot string) error {
	root := m.ComfyDir
	shared := filepath.Join(root, "storage-models")
	user := filepath.Join(root, "storage-user")
	for _, dir := range []string{
		filepath.Join(shared, "models"), filepath.Join(shared, "hf-hub"), filepath.Join(shared, "torch-hub"),
		filepath.Join(user, "input"), filepath.Join(user, "user-profile"), filepath.Join(user, "user-scripts"),
		filepath.Join(user, "output-"+slot), filepath.Join(root, "storage-"+slot),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	m.Seed()
	return nil
}

func hasName(names []string, name string) bool {
	for _, n := range names {
		if n == name {
			return true
		}
	}
	return false
}

// Create starts an instance bound to cards[i]. The vendor decides the image
// and the passthrough, the slot the name and private directories, the port
// is the first free one in the range the console already probes.
func (m *Manager) Create(ctx context.Context, cards []vendors.Card, i int) (string, error) {
	card := cards[i]
	spec := Template(card.Vendor)
	if spec == nil {
		return "", &Invalid{fmt.Sprintf("沒有 %s 的 ComfyUI 映像範本", card.Vendor)}
	}
	slot := Slot(cards, i)
	name := Prefix + "-" + slot
	if hasName(m.Docker.Names(ctx), name) {
		return "", &Invalid{name + " 已經存在"}
	}
	taken := m.takenPorts(ctx, cards, "")
	port := 0
	for _, p := range m.Ports {
		if !taken[p] {
			port = p
			break
		}
	}
	if port == 0 {
		return "", &Invalid{fmt.Sprintf("連接埠 %d-%d 都被佔用了", m.Ports[0], m.Ports[len(m.Ports)-1])}
	}
	if err := m.mkdirs(slot); err != nil {
		return "", err
	}
	args := []string{"run", "-d", "--name", name, "--restart", "unless-stopped", "-p", fmt.Sprintf("127.0.0.1:%d:%d", port, inside)}
	args = append(args, deviceFlags(card, cards)...)
	args = append(args, m.volumes(slot)...)
	args = append(args, spec.Image)
	if _, ok := m.Docker.Command(ctx, args...); !ok {
		return "", &Invalid{fmt.Sprintf("無法建立 %s，詳細原因在主控台的日誌裡", name)}
	}
	log.Printf("created ComfyUI instance %s on %s port %d", name, card.Vendor, port)

	// Published as well as created, or a new card gets an instance nobody
	// in the house can open. Not fatal: the instance works on loopback.
	label := slot
	if card.Name != nil && *card.Name != "" {
		label = *card.Name
	}
	if _, err := m.Channels.PublishComfy(ctx, port, spec.Label+" -- "+label); err != nil {
		log.Printf("created %s but could not publish it through Caddy: %v", name, err)
	}
	return name, nil
}

// The node that makes a second card mean anything: ComfyUI runs its graph
// on one device, and this places components by device.
const (
	multiGPURepo = "https://github.com/pollockjj/ComfyUI-MultiGPU"
	multiGPUDir  = "ComfyUI-MultiGPU"
)

// EnsureMultiGPU installs the node through the container, since
// custom_nodes is root-owned inside it. A failure is reported, not raised.
func (m *Manager) EnsureMultiGPU(ctx context.Context, name string) bool {
	target := "/root/ComfyUI/custom_nodes/" + multiGPUDir
	if _, ok := m.Docker.Command(ctx, "exec", name, "test", "-d", target); ok {
		return true
	}
	log.Printf("installing %s into %s", multiGPUDir, name)
	if _, ok := m.Docker.Command(ctx, "exec", name, "git", "clone", "--depth", "1", multiGPURepo, target); !ok {
		log.Printf("could not install %s into %s", multiGPUDir, name)
		return false
	}
	return true
}

func hostPort(info map[string]any) (int, bool) {
	host, _ := info["HostConfig"].(map[string]any)
	bindings, _ := host["PortBindings"].(map[string]any)
	found, ok := 0, false
	for _, list := range bindings {
		items, _ := list.([]any)
		for _, item := range items {
			b, _ := item.(map[string]any)
			if s, _ := b["HostPort"].(string); s != "" {
				if n, err := strconv.Atoi(s); err == nil {
					found, ok = n, true
				}
			}
		}
	}
	return found, ok
}

// Reconfigure rebuilds one instance with a different set of cards. A
// container is bound to its cards at docker run, so changing them means
// replacing it; the name, port, directories and site block are kept.
func (m *Manager) Reconfigure(ctx context.Context, name string, chosen, cards []vendors.Card, cliArgs string, port *int) error {
	if len(chosen) == 0 {
		return &Invalid{"至少要指定一張卡"}
	}
	info := m.Docker.Inspect(ctx, []string{name})[name]
	if info == nil {
		return &Invalid{"沒有這個容器：" + name}
	}
	config, _ := info["Config"].(map[string]any)
	image, _ := config["Image"].(string)
	if image == "" {
		return &Invalid{"讀不到 " + name + " 的映像名稱"}
	}
	current, ok := hostPort(info)
	if !ok {
		return &Invalid{"讀不到 " + name + " 的連接埠"}
	}
	target := current
	if port != nil {
		target = *port
	}
	if target < 1024 || target > 65535 {
		return &Invalid{"連接埠要在 1024-65535 之間"}
	}
	if target != current && m.takenPorts(ctx, cards, name)[target] {
		return &Invalid{fmt.Sprintf("連接埠 %d 已經被別的容器用了", target)}
	}
	slot := strings.TrimPrefix(name, Prefix+"-")

	// Before the teardown, while there is still a container to run it in.
	if len(chosen) > 1 {
		m.EnsureMultiGPU(ctx, name)
	}
	// The site block is keyed on the upstream port, so it only moves when
	// that does.
	if err := m.Destroy(ctx, name, false, target != current); err != nil {
		return err
	}
	args := []string{"run", "-d", "--name", name, "--restart", "unless-stopped", "-p", fmt.Sprintf("127.0.0.1:%d:%d", target, inside)}
	for _, card := range chosen {
		args = append(args, deviceFlags(card, cards)...)
	}
	args = append(args, "-e", "CLI_ARGS="+cliArgs)
	args = append(args, m.volumes(slot)...)
	args = append(args, image)
	if _, ok := m.Docker.Command(ctx, args...); !ok {
		return &Invalid{fmt.Sprintf("無法重建 %s，詳細原因在主控台的日誌裡", name)}
	}
	if target != current {
		if _, err := m.Channels.PublishComfy(ctx, target, name); err != nil {
			log.Printf("rebuilt %s on :%d but could not publish it: %v", name, target, err)
		}
	}
	log.Printf("rebuilt %s on %d card(s), port %d, CLI_ARGS=%q", name, len(chosen), target, cliArgs)
	return nil
}

// State is what the image side of one card's row says: the image behind
// the running instance when there is one, the template's otherwise.
func (m *Manager) State(ctx context.Context, cards []vendors.Card, i int, boxes []api.HeldContainer) api.ComfyState {
	card := cards[i]
	spec := Template(card.Vendor)
	st := api.ComfyState{Template: spec, Slot: Slot(cards, i), Job: m.JobFor(card.PCIBDFAddress)}
	if len(boxes) > 0 {
		box := boxes[0]
		st.Container = &box.Name
		st.Image = box.Image
	}
	if st.Image == nil && spec != nil {
		img := spec.Image
		st.Image = &img
	}
	if st.Image != nil {
		if size, ok := m.Docker.ImageSizes(ctx)[*st.Image]; ok {
			st.ImageSize = &size
		}
	}
	return st
}

// Destroy stops and removes one instance and optionally its image. Its
// directories stay: outputs and a settings profile took someone time.
func (m *Manager) Destroy(ctx context.Context, name string, deleteImage, unpublish bool) error {
	if !hasName(m.Docker.Names(ctx), name) {
		return &Invalid{"沒有這個容器：" + name}
	}
	info := m.Docker.Inspect(ctx, []string{name})[name]
	image := ""
	if deleteImage {
		config, _ := info["Config"].(map[string]any)
		image, _ = config["Image"].(string)
	}
	upstream, hadPort := hostPort(info)
	m.Docker.Command(ctx, "rm", "-f", name)
	if hadPort && unpublish {
		if err := m.Channels.UnpublishComfy(ctx, upstream); err != nil {
			log.Printf("removed %s but could not unpublish :%d: %v", name, upstream, err)
		}
	}
	if image != "" {
		if _, ok := m.Docker.Command(ctx, "rmi", image); !ok {
			log.Printf("removed %s but could not delete %s", name, image)
		}
	}
	return nil
}

func (m *Manager) JobFor(address string) *api.Job {
	m.mu.Lock()
	defer m.mu.Unlock()
	if job, ok := m.jobs[m.BusKey(address)]; ok {
		copy := *job
		return &copy
	}
	return nil
}

type jobProgress struct {
	m   *Manager
	job *api.Job
}

func (p jobProgress) Layer(done, total int) {
	p.m.mu.Lock()
	p.job.LayersDone, p.job.LayersTotal = done, total
	p.m.mu.Unlock()
}
func (p jobProgress) Bytes(done, total int64) {
	p.m.mu.Lock()
	p.job.BytesDone, p.job.BytesTotal = done, total
	p.m.mu.Unlock()
}
func (p jobProgress) Message(text string) { p.m.mu.Lock(); p.job.Message = text; p.m.mu.Unlock() }
func (p jobProgress) Failed(text string) {
	p.m.mu.Lock()
	p.job.State = "error"
	if text != "" {
		p.job.Message = text
	}
	p.m.mu.Unlock()
}

// Start begins a create or an update in the background and returns at
// once: the images are 16 to 20 GB, and a button that spins for minutes is
// indistinguishable from one that has hung.
func (m *Manager) Start(ctx context.Context, cards []vendors.Card, i int, action, name string) (api.Job, error) {
	card := cards[i]
	key := m.BusKey(card.PCIBDFAddress)
	m.mu.Lock()
	if running, ok := m.jobs[key]; ok && (running.State == "pulling" || running.State == "starting") {
		copy := *running
		m.mu.Unlock()
		return copy, nil
	}
	m.mu.Unlock()

	spec := Template(card.Vendor)
	if spec == nil {
		return api.Job{}, &Invalid{fmt.Sprintf("沒有 %s 的 ComfyUI 映像範本", card.Vendor)}
	}
	if action == "create" && hasName(m.Docker.Names(ctx), Prefix+"-"+Slot(cards, i)) {
		return api.Job{}, &Invalid{"這張卡上已經有 ComfyUI 實例了"}
	}
	if action == "update" && name == "" {
		return api.Job{}, &Invalid{"要更新哪一個實例？"}
	}
	image := spec.Image
	if action == "update" {
		if info := m.Docker.Inspect(ctx, []string{name})[name]; info != nil {
			if config, _ := info["Config"].(map[string]any); config != nil {
				if img, _ := config["Image"].(string); img != "" {
					image = img
				}
			}
		}
	}
	job := &api.Job{Card: key, Action: action, State: "pulling"}
	m.mu.Lock()
	m.jobs[key] = job
	m.mu.Unlock()

	cardsCopy := append([]vendors.Card(nil), cards...)
	go func() {
		bg := context.Background()
		// Pulled explicitly rather than left to docker run, which would do
		// it silently and give this nothing to report.
		if !m.Docker.Pull(bg, image, jobProgress{m, job}) {
			return
		}
		m.mu.Lock()
		job.State = "starting"
		m.mu.Unlock()
		var err error
		if action == "update" {
			// The port does not change, so the site block does not either.
			err = m.Destroy(bg, name, false, false)
		}
		if err == nil {
			_, err = m.Create(bg, cardsCopy, i)
		}
		m.mu.Lock()
		if err != nil {
			job.State, job.Message = "error", err.Error()
			log.Printf("ComfyUI %s on %s failed: %v", action, key, err)
		} else {
			job.State = "done"
		}
		m.mu.Unlock()
	}()
	return *job, nil
}
