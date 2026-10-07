// Package profile names the machine, a model's files and its engine the way
// the parameter workshop matches them (§4 and §6 of the workshop devlog):
// a GPU by its marketing name and the number of cards the model runs on, a
// model by its Hugging Face repo, file and quantisation, an engine by key
// and version.
//
// It is pure functions over plain inputs. What the console knows -- the
// cards, /proc, llama-swap's config, the engine registry, docker -- is
// fetched by the HTTP layer and handed in, so every rule here is tested
// without hardware. Nothing machine-specific may come out: no path, host,
// user or container name, because these values are what a run exports and
// what the workshop will one day receive (§11).
package profile

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/NoobBandi/TenkStack/internal/schema"
)

// Card is one GPU as the console knows it.
type Card struct {
	Vendor  string // intel | nvidia | amd, as internal/gpu keys them
	Name    string // as the driver reports it
	VRAMMiB int    // total, 0 when unknown
	PCIe    string // the link into the board: "PCIe 4.0 x8"; "" when unknown
	// Ordinal is the card's number in its vendor's selector variable
	// (level_zero:N, CUDA_VISIBLE_DEVICES=N); -1 when unknown.
	Ordinal int
}

// Trademark marks and the words around them that differ between tools
// reporting the same card: xpu-smi says "Intel(R) Arc(TM) Pro B70 Graphics",
// llama.cpp's device list the same, sycl-ls sometimes "Intel® Arc™".
var marks = regexp.MustCompile(`(?i)\((?:R|TM|C)\)|[®™©]`)

// clean drops trademark marks and runs of spaces.
func clean(name string) string {
	return strings.Join(strings.Fields(marks.ReplaceAllString(name, " ")), " ")
}

var vendorBrand = map[string]string{"intel": "Intel", "nvidia": "NVIDIA", "amd": "AMD"}

// NormalizeGPU is a card's model as the workshop compares it: the
// marketing name with the trademark marks gone, the vendor's brand in
// front exactly once, and Intel's trailing "Graphics" dropped when a model
// number precedes it. Two tools naming one card must agree, and two cards
// must stay apart: a suffix such as "-80GB" or "Ada Generation" is a
// different product with different memory, so it is kept.
//
//	Intel(R) Arc(TM) Pro B70 Graphics -> Intel Arc Pro B70
//	GeForce RTX 3090                  -> NVIDIA GeForce RTX 3090
//	Radeon RX 7900 XTX                -> AMD Radeon RX 7900 XTX
func NormalizeGPU(vendor, name string) string {
	n := clean(name)
	if n == "" {
		return ""
	}
	words := strings.Fields(n)
	// "Graphics" on its own names an integrated GPU with no model number
	// (Intel Arc Graphics, AMD Radeon Graphics): there it is the name.
	if len(words) > 1 && strings.EqualFold(words[len(words)-1], "Graphics") && strings.ContainsAny(words[len(words)-2], "0123456789") {
		words = words[:len(words)-1]
	}
	n = strings.Join(words, " ")
	brand := vendorBrand[vendor]
	if brand == "" {
		return n
	}
	// The brand as the vendor writes it, whatever case the tool used.
	if first := words[0]; strings.EqualFold(first, brand) {
		return brand + strings.TrimPrefix(n, first)
	}
	// Older NVIDIA tools omit the brand: "Tesla T4", "GeForce GTX 1080 Ti".
	return brand + " " + n
}

// CleanCPU is a CPU's model as /proc/cpuinfo has it, with trademark marks
// and padding removed. The workshop only compares CPUs loosely (same or
// different, §6), so no further normalisation is attempted.
func CleanCPU(model string) string { return clean(model) }

// Hardware is the profile of the cards a model runs on (see CardsUsed),
// the CPU and the host's memory. Several cards are described by the first
// one's model and count; where they differ, the smallest memory and the
// slowest link, since those are what bound a model split across them.
func Hardware(used []Card, cpuModel string, ramBytes int64) schema.HardwareProfile {
	out := schema.HardwareProfile{CPU: schema.CPU{Model: CleanCPU(cpuModel)}, RAMMiB: int(ramBytes >> 20)}
	if len(used) == 0 {
		return out
	}
	first := used[0]
	out.GPU = schema.GPU{Vendor: first.Vendor, Model: NormalizeGPU(first.Vendor, first.Name), VRAMMiB: first.VRAMMiB,
		Count: len(used), PCIe: first.PCIe}
	for _, c := range used[1:] {
		if c.VRAMMiB > 0 && (out.GPU.VRAMMiB == 0 || c.VRAMMiB < out.GPU.VRAMMiB) {
			out.GPU.VRAMMiB = c.VRAMMiB
		}
		if c.PCIe != "" && (out.GPU.PCIe == "" || linkRate(c.PCIe) < linkRate(out.GPU.PCIe)) {
			out.GPU.PCIe = c.PCIe
		}
	}
	return out
}

var linkText = regexp.MustCompile(`(\d+(?:\.\d+)?)\s+x(\d+)`)

// GT/s per lane by PCIe generation, enough to order two links.
var genRate = map[string]float64{"1.0": 2.5, "2.0": 5, "3.0": 8, "4.0": 16, "5.0": 32, "6.0": 64, "7.0": 128}

// linkRate is a link's raw rate, lanes times per-lane rate; 0 when the
// text is not "PCIe G xW".
func linkRate(link string) float64 {
	m := linkText.FindStringSubmatch(link)
	if m == nil {
		return 0
	}
	lanes, _ := strconv.Atoi(m[2])
	return genRate[m[1]] * float64(lanes)
}
