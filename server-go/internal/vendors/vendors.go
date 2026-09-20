// Package vendors describes each kind of card once: what llama.cpp calls
// its backend, how a device is pinned, which images serve it, and how a card
// is handed to a container and read back out of one. Adding a card is a new
// record here, not edits in six places.
package vendors

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
)

// Card is what the container side needs to know about one card.
type Card struct {
	PCIBDFAddress string
	Name          *string
	Vendor        string
}

// Image is a container image and what running it needs of the host.
type Image struct {
	Image string
	// Requires names something the host must already have, so the UI can
	// say it before a multi-gigabyte download.
	Requires string
	// Verified is false for a recipe written from documentation and never
	// run here.
	Verified bool
	Flags    []string
}

type Vendor struct {
	Key   string
	Label string
	// Backends are the names --list-devices prints, upper case.
	Backends []string
	// Selector is the variable and value template that pins one device; the
	// value is the backend's own index, not the console's.
	SelectorVar      string
	SelectorTemplate string

	// Comfy is the ComfyUI image for this vendor's cards. The inference
	// runtimes live in internal/providers, one image per vendor each.
	Comfy *Image

	// DeviceFlags are the docker run arguments that hand one card over.
	DeviceFlags func(card Card, cards []Card) []string
	// Claims is the inverse: which cards a container's HostConfig got, and
	// whether it asked for a GPU at all.
	Claims func(host map[string]any, cards []Card) ([]string, bool)
	// Slot is a short name for an instance on this card: xpu, nv0.
	Slot func(index int) string
}

func (v Vendor) Selector(indices string) string {
	return strings.ReplaceAll(v.SelectorTemplate, "{}", indices)
}

var intel = Vendor{
	Key: "intel", Label: "Intel (SYCL)",
	Backends: []string{"SYCL"},
	// level_zero:N rather than a bare index: without the prefix SYCL can pick
	// the CPU OpenCL device and run everything on the CPU.
	SelectorVar: "ONEAPI_DEVICE_SELECTOR", SelectorTemplate: "level_zero:{}",
	Comfy: &Image{Image: "yanwk/comfyui-boot:xpu", Verified: true},
	DeviceFlags: func(card Card, _ []Card) []string {
		return []string{"--device", RenderPath(card.PCIBDFAddress)}
	},
	Claims: ClaimsByRender,
	Slot: func(index int) string {
		if index == 0 {
			return "xpu"
		}
		return fmt.Sprintf("xpu%d", index)
	},
}

// ROCm needs the compute node as well as the render node, and the group
// that owns them. Unverified: no AMD card has been in the machine this was
// written on.
var amd = Vendor{
	Key: "amd", Label: "AMD (ROCm)",
	Backends:    []string{"ROCM", "HIP"},
	SelectorVar: "HIP_VISIBLE_DEVICES", SelectorTemplate: "{}",
	Comfy: &Image{Image: "yanwk/comfyui-boot:rocm"},
	DeviceFlags: func(card Card, _ []Card) []string {
		return []string{"--device", RenderPath(card.PCIBDFAddress),
			"--device", "/dev/kfd", "--group-add", "video", "--security-opt", "seccomp=unconfined"}
	},
	Claims: ClaimsByRender,
	Slot:   func(index int) string { return fmt.Sprintf("rocm%d", index) },
}

// NVIDIA cards reach a container as a device request handled by the
// container toolkit, which has to be on the host.
var nvidia = Vendor{
	Key: "nvidia", Label: "NVIDIA (CUDA)",
	Backends:    []string{"CUDA"},
	SelectorVar: "CUDA_VISIBLE_DEVICES", SelectorTemplate: "{}",
	Comfy: &Image{Image: "yanwk/comfyui-boot:cu130-slim-v2", Requires: "nvidia-container-toolkit", Verified: true},
	DeviceFlags: func(card Card, cards []Card) []string {
		return []string{"--gpus", fmt.Sprintf("device=%d", nvidiaOrdinal(card, cards))}
	},
	Claims: nvidiaClaims,
	Slot:   func(index int) string { return fmt.Sprintf("nv%d", index) },
}

// nvidiaOrdinal is this card's position among the NVIDIA cards alone.
func nvidiaOrdinal(card Card, cards []Card) int {
	n := 0
	for _, c := range cards {
		if c.Vendor != "nvidia" {
			continue
		}
		if c.PCIBDFAddress == card.PCIBDFAddress && ptrEq(c.Name, card.Name) {
			return n
		}
		n++
	}
	return 0
}

func ptrEq(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func nvidiaClaims(host map[string]any, cards []Card) ([]string, bool) {
	var mine []Card
	for _, c := range cards {
		if c.Vendor == "nvidia" {
			mine = append(mine, c)
		}
	}
	var claimed []string
	wants := false
	requests, _ := host["DeviceRequests"].([]any)
	for _, item := range requests {
		req, _ := item.(map[string]any)
		if req == nil || !wantsGPU(req) {
			continue
		}
		wants = true
		ids, _ := req["DeviceIDs"].([]any)
		all := len(ids) == 0
		for _, id := range ids {
			if s, _ := id.(string); s == "all" {
				all = true
			}
		}
		if all {
			for _, c := range mine {
				if c.PCIBDFAddress != "" {
					claimed = append(claimed, c.PCIBDFAddress)
				}
			}
			continue
		}
		for _, id := range ids {
			text := fmt.Sprint(id)
			if n, err := strconv.Atoi(text); err == nil {
				if n < len(mine) && mine[n].PCIBDFAddress != "" {
					claimed = append(claimed, mine[n].PCIBDFAddress)
				}
				continue
			}
			// A UUID pins a card that may move ordinal; the card list here
			// carries none, so this matches nothing, as it did before.
		}
	}
	return claimed, wants
}

func wantsGPU(req map[string]any) bool {
	groups, _ := req["Capabilities"].([]any)
	for _, g := range groups {
		caps, _ := g.([]any)
		for _, c := range caps {
			if s, _ := c.(string); s == "gpu" {
				return true
			}
		}
	}
	return false
}

// All is every vendor in a stable order: Intel first, then alphabetical.
// The order decides the console's global device numbering.
func All() []Vendor { return []Vendor{intel, amd, nvidia} }

func Get(key string) *Vendor {
	for _, v := range All() {
		if v.Key == key {
			return &v
		}
	}
	return nil
}

// Selector is how one backend pins a device: the variable and its template.
type Selector struct {
	Variable string
	Template string
}

// BackendSelectors maps a backend name, as --list-devices prints it, to
// how one of its devices is pinned. Vulkan is not a vendor: it runs on any
// of them, which is what makes it the fallback rather than a row.
func BackendSelectors() map[string]Selector {
	out := map[string]Selector{"VULKAN": {"GGML_VK_VISIBLE_DEVICES", "{}"}}
	for _, v := range All() {
		for _, b := range v.Backends {
			out[strings.ToUpper(b)] = Selector{v.SelectorVar, v.SelectorTemplate}
		}
	}
	return out
}

// SelectorVariables are the environment variables a device choice is
// written as.
func SelectorVariables() map[string]bool {
	out := map[string]bool{}
	for _, s := range BackendSelectors() {
		out[s.Variable] = true
	}
	return out
}

// RenderPath is the device path for one card's render node, found by PCI
// address (render numbering is probe order) and handed over by number
// (docker parses a colon in --device as a permission field). Falls back to
// all of /dev/dri where the machine has no by-path links.
func RenderPath(address string) string {
	node := "/dev/dri/by-path/pci-" + strings.ToLower(address) + "-render"
	if resolved, err := filepath.EvalSymlinks(node); err == nil {
		return resolved
	}
	return "/dev/dri"
}

// PCIForRender is the card behind /dev/dri/renderD128, as a PCI address.
func PCIForRender(node string) string {
	resolved, err := filepath.EvalSymlinks(filepath.Join("/sys/class/drm", node, "device"))
	if err != nil {
		return ""
	}
	return filepath.Base(resolved)
}

// ClaimsByRender reads which cards a container got, for vendors that pass a
// render node.
func ClaimsByRender(host map[string]any, _ []Card) ([]string, bool) {
	var claimed []string
	wants := false
	devices, _ := host["Devices"].([]any)
	for _, item := range devices {
		entry, _ := item.(map[string]any)
		path, _ := entry["PathOnHost"].(string)
		if !strings.HasPrefix(path, "/dev/dri/render") {
			continue
		}
		wants = true
		if address := PCIForRender(filepath.Base(path)); address != "" {
			claimed = append(claimed, address)
		}
	}
	return claimed, wants
}
