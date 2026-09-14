// Package versions collects what is installed and running, each probe
// failing independently so one stopped service does not blank the page.
package versions

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
)

// Inputs are the facts the caller already holds.
type Inputs struct {
	LlamaSwapBin string
	CaddyBin     string
	LlamaCppDir  string
	OneAPIDir    string
	// Launchers are macro name and path; the name is what the row shows.
	Launchers  [][2]string
	ComfyPorts []int
	// Running is the build serving requests now, from llama-server's props.
	Running *string
	// GPU is device 0's raw discovery record.
	GPU     map[string]any
	Console string
}

func run(ctx context.Context, timeout time.Duration, name string, args ...string) string {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil && len(out) == 0 {
		return ""
	}
	return strings.TrimSpace(string(out))
}

var swapVersion = regexp.MustCompile(`(v[\d.]+)\s*\(([0-9a-f]+)\)`)

func llamaSwap(ctx context.Context, bin string) *string {
	out := run(ctx, 5*time.Second, bin, "--version")
	if out == "" {
		return nil
	}
	if m := swapVersion.FindStringSubmatch(out); m != nil {
		s := m[1] + " (" + m[2] + ")"
		return &s
	}
	first := strings.SplitN(out, "\n", 2)[0]
	return &first
}

func caddy(ctx context.Context, bin string) *string {
	out := run(ctx, 5*time.Second, bin, "version")
	if out == "" {
		return nil
	}
	first := strings.Fields(out)[0]
	return &first
}

func source(ctx context.Context, dir string) *string {
	out := run(ctx, 5*time.Second, "git", "-C", dir, "log", "-1", "--format=%h (%ad)", "--date=short")
	if out == "" {
		return nil
	}
	return &out
}

// launchers asks each configured launcher for --version: no model needs to
// be loaded, and it reaches a launcher that has never served anything.
func launchers(ctx context.Context, macros [][2]string) []api.LauncherVersion {
	out := []api.LauncherVersion{}
	for _, m := range macros {
		name, p := m[0], m[1]
		text := run(ctx, 90*time.Second, p, "--version")
		if text == "" {
			continue
		}
		version, built := "", ""
		for _, line := range strings.Split(text, "\n") {
			if version == "" && strings.HasPrefix(line, "version:") {
				version = strings.TrimSpace(strings.TrimPrefix(line, "version:"))
			}
			if built == "" && strings.HasPrefix(line, "built with") {
				built = strings.TrimSpace(strings.TrimPrefix(line, "built with"))
			}
		}
		if version == "" {
			version = strings.SplitN(text, "\n", 2)[0]
		}
		out = append(out, api.LauncherVersion{Launcher: name, Version: version, Built: built})
	}
	return out
}

// comfy probes every port an instance might answer on; each reports its
// own stack because two cards may run two different builds.
func comfy(ctx context.Context, ports []int) []api.ComfyVersion {
	out := []api.ComfyVersion{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	client := &http.Client{Timeout: 3 * time.Second}
	for _, port := range ports {
		wg.Add(1)
		go func(port int) {
			defer wg.Done()
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:"+itoa(port)+"/system_stats", nil)
			resp, err := client.Do(req)
			if err != nil {
				return
			}
			defer resp.Body.Close()
			if resp.StatusCode >= 400 {
				return
			}
			var body struct {
				System  map[string]any   `json:"system"`
				Devices []map[string]any `json:"devices"`
			}
			if json.NewDecoder(resp.Body).Decode(&body) != nil {
				return
			}
			v := api.ComfyVersion{Port: port, ComfyUI: body.System["comfyui_version"], PyTorch: body.System["pytorch_version"]}
			if len(body.Devices) > 0 {
				v.Device, _ = body.Devices[0]["name"].(string)
			}
			if py, _ := body.System["python_version"].(string); py != "" {
				if f := strings.Fields(py); len(f) > 0 {
					v.Python = &f[0]
				}
			}
			mu.Lock()
			out = append(out, v)
			mu.Unlock()
		}(port)
	}
	wg.Wait()
	sort.Slice(out, func(i, j int) bool { return out[i].Port < out[j].Port })
	return out
}

var oneapiVersion = regexp.MustCompile(`^20\d\d\.\d+$`)

func oneapi(dir string) *string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var found []string
	for _, e := range entries {
		if oneapiVersion.MatchString(e.Name()) {
			found = append(found, e.Name())
		}
	}
	if len(found) == 0 {
		return nil
	}
	sort.Sort(sort.Reverse(sort.StringSlice(found)))
	return &found[0]
}

func itoa(n int) string { return strconv.Itoa(n) }

// Collect gathers everything, grouped the way the machine is arranged.
func Collect(ctx context.Context, in Inputs) api.Versions {
	var (
		swap, cad, src *string
		launch         []api.LauncherVersion
		instances      []api.ComfyVersion
		wg             sync.WaitGroup
	)
	wg.Add(5)
	go func() { defer wg.Done(); swap = llamaSwap(ctx, in.LlamaSwapBin) }()
	go func() { defer wg.Done(); cad = caddy(ctx, in.CaddyBin) }()
	go func() { defer wg.Done(); src = source(ctx, in.LlamaCppDir) }()
	go func() { defer wg.Done(); launch = launchers(ctx, in.Launchers) }()
	go func() { defer wg.Done(); instances = comfy(ctx, in.ComfyPorts) }()
	wg.Wait()

	system := []api.LabelValue{}
	add := func(label string, value any) {
		if value == nil {
			return
		}
		if s, ok := value.(string); ok && s == "" {
			return
		}
		if p, ok := value.(*string); ok {
			if p == nil || *p == "" {
				return
			}
			value = *p
		}
		system = append(system, api.LabelValue{Label: label, Value: value})
	}
	add("GPU 驅動", in.GPU["driver_version"])
	add("核心", in.GPU["kernel_version"])
	add("oneAPI", oneapi(in.OneAPIDir))
	add("韌體", in.GPU["gfx_firmware_status"])
	add("Caddy", cad)

	return api.Versions{
		Inference: api.Inference{Launchers: launch, Running: in.Running, Source: src, Swap: swap},
		ComfyUI:   instances,
		Console:   in.Console,
		System:    system,
	}
}
