package profile

import (
	"slices"
	"testing"

	"github.com/NoobBandi/TenkStack/internal/schema"
)

func TestNormalizeGPU(t *testing.T) {
	cases := []struct{ vendor, name, want string }{
		// xpu-smi and llama.cpp's device list on the B70 machine.
		{"intel", "Intel(R) Arc(TM) Pro B70 Graphics", "Intel Arc Pro B70"},
		{"intel", "Intel(R) Arc(TM) Pro B60 Graphics", "Intel Arc Pro B60"},
		{"intel", "Intel(R) Arc(TM) A770 Graphics", "Intel Arc A770"},
		{"intel", "Intel(R) Arc(TM) B580 Graphics", "Intel Arc B580"},
		{"intel", "Intel® Arc™ A380 Graphics", "Intel Arc A380"},
		{"intel", "Intel(R) Data Center GPU Max 1550", "Intel Data Center GPU Max 1550"},
		// An integrated GPU has no number; "Graphics" is its name.
		{"intel", "Intel(R) Arc(TM) Graphics", "Intel Arc Graphics"},
		{"intel", "Arc Pro B70", "Intel Arc Pro B70"},
		// nvidia-smi.
		{"nvidia", "NVIDIA GeForce RTX 4090", "NVIDIA GeForce RTX 4090"},
		{"nvidia", "NVIDIA GeForce RTX 5090", "NVIDIA GeForce RTX 5090"},
		{"nvidia", "NVIDIA RTX 6000 Ada Generation", "NVIDIA RTX 6000 Ada Generation"},
		{"nvidia", "NVIDIA A100-SXM4-80GB", "NVIDIA A100-SXM4-80GB"},
		{"nvidia", "NVIDIA H100 80GB HBM3", "NVIDIA H100 80GB HBM3"},
		{"nvidia", "Tesla T4", "NVIDIA Tesla T4"},
		{"nvidia", "GeForce GTX 1080 Ti", "NVIDIA GeForce GTX 1080 Ti"},
		{"nvidia", "Nvidia  GeForce RTX 3090", "NVIDIA GeForce RTX 3090"},
		// amd-smi market names and rocm-smi card series.
		{"amd", "AMD Radeon RX 7900 XTX", "AMD Radeon RX 7900 XTX"},
		{"amd", "Radeon RX 7900 XTX", "AMD Radeon RX 7900 XTX"},
		{"amd", "AMD Radeon PRO W7900", "AMD Radeon PRO W7900"},
		{"amd", "AMD Instinct MI300X", "AMD Instinct MI300X"},
		{"amd", "AMD Radeon Graphics", "AMD Radeon Graphics"},
		{"", "Some Card(TM) 9", "Some Card 9"},
		{"intel", "", ""},
	}
	for _, c := range cases {
		if got := NormalizeGPU(c.vendor, c.name); got != c.want {
			t.Errorf("NormalizeGPU(%q, %q) = %q, want %q", c.vendor, c.name, got, c.want)
		}
	}
}

func TestCleanCPU(t *testing.T) {
	for in, want := range map[string]string{
		"AMD Ryzen 7 5700X 8-Core Processor":          "AMD Ryzen 7 5700X 8-Core Processor",
		"Intel(R) Core(TM) i9-13900K":                 "Intel Core i9-13900K",
		"  Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz ": "Intel Xeon Gold 6338 CPU @ 2.00GHz",
	} {
		if got := CleanCPU(in); got != want {
			t.Errorf("CleanCPU(%q) = %q, want %q", in, got, want)
		}
	}
}

var b70 = Card{Vendor: "intel", Name: "Intel(R) Arc(TM) Pro B70 Graphics", VRAMMiB: 32656, PCIe: "PCIe 4.0 x8"}

func TestHardware(t *testing.T) {
	a, b := b70, b70
	a.Ordinal, b.Ordinal = 0, 1
	got := Hardware([]Card{a, b}, "AMD Ryzen 7 5700X 8-Core Processor", 128731<<20+512)
	want := schema.HardwareProfile{
		GPU: schema.GPU{Vendor: "intel", Model: "Intel Arc Pro B70", VRAMMiB: 32656, Count: 2, PCIe: "PCIe 4.0 x8"},
		CPU: schema.CPU{Model: "AMD Ryzen 7 5700X 8-Core Processor"}, RAMMiB: 128731,
	}
	if got != want {
		t.Errorf("two B70s:\n got %+v\nwant %+v", got, want)
	}

	// The slower link and the smaller card bound a split model.
	b.PCIe, b.VRAMMiB = "PCIe 3.0 x16", 24000
	a.PCIe = "PCIe 4.0 x4"
	got = Hardware([]Card{a, b}, "", 0)
	if got.GPU.PCIe != "PCIe 4.0 x4" || got.GPU.VRAMMiB != 24000 {
		t.Errorf("mixed links: %+v", got.GPU)
	}

	if got := Hardware(nil, "x", 1<<30); got.GPU != (schema.GPU{}) || got.RAMMiB != 1024 {
		t.Errorf("no cards: %+v", got)
	}
}

func cardsOf(vendor string, n int) []Card {
	out := make([]Card, n)
	for i := range out {
		out[i] = Card{Vendor: vendor, Name: vendor + " card", Ordinal: i, VRAMMiB: 1000 + i}
	}
	return out
}

func ordinals(cards []Card) []int {
	out := []int{}
	for _, c := range cards {
		out = append(out, c.Ordinal)
	}
	return out
}

func TestCardsUsed(t *testing.T) {
	two := cardsOf("intel", 2)
	mixed := append(cardsOf("intel", 2), cardsOf("nvidia", 2)...)
	sel := func(v string) map[string]string { return map[string]string{"ONEAPI_DEVICE_SELECTOR": v} }
	cases := []struct {
		name   string
		cards  []Card
		env    map[string]string
		cmd    string
		engine string
		vendor string
		want   []int
	}{
		// The B70 machine's entries.
		{"vllm TP=2 on both", two, sel("level_zero:0,1"), "${vllm-intel} --tensor-parallel-size 2", "vllm", "intel", []int{0, 1}},
		{"vllm on card 1", two, sel("level_zero:1"), "${vllm-intel} --max-model-len 262144", "vllm", "intel", []int{1}},
		{"llama on card 0", two, sel("level_zero:0"), "${llama-intel} --parallel 2", "llamacpp", "intel", []int{0}},
		{"llama on both, tensor split", two, sel("level_zero:0,1"), "${llama-intel} --split-mode tensor", "llamacpp", "intel", []int{0, 1}},
		{"strata, nothing pinned", two, nil, "/x/strata-sycl/llama-swap-serve.sh ${PORT}", "strata", "intel", []int{0, 1}},

		// Nothing pinned: every card the engine sees, narrowed by its flags.
		{"vllm unpinned takes TP cards", two, nil, "--tensor-parallel-size 2", "vllm", "intel", []int{0, 1}},
		{"vllm unpinned without TP is one card", two, nil, "--model x", "vllm", "intel", []int{0}},
		{"vllm TP x PP", cardsOf("intel", 4), nil, "-tp 2 -pp 2", "vllm", "intel", []int{0, 1, 2, 3}},
		{"vllm data parallel", cardsOf("intel", 4), nil, "--tensor-parallel-size=1 --data-parallel-size 2", "vllm", "intel", []int{0, 1}},
		{"sglang tp", cardsOf("intel", 4), nil, "--tp 2", "sglang", "intel", []int{0, 1}},
		{"sglang dp attention shares the group", cardsOf("intel", 4), nil, "--tp 2 --dp 2 --enable-dp-attention", "sglang", "intel", []int{0, 1}},
		{"llama unpinned sees all", two, nil, "--n-gpu-layers 99", "llamacpp", "intel", []int{0, 1}},
		{"llama split none keeps main gpu", two, nil, "-sm none -mg 1", "llamacpp", "intel", []int{1}},
		{"llama split none defaults to 0", two, nil, "--split-mode none", "llamacpp", "intel", []int{0}},
		{"llama zero share", two, nil, "--tensor-split 1,0", "llamacpp", "intel", []int{0}},
		{"llama share list shorter than cards", cardsOf("intel", 3), nil, "-ts 6,5", "llamacpp", "intel", []int{0, 1}},
		{"llama all-zero split is ignored", two, nil, "-ts 0,0", "llamacpp", "intel", []int{0, 1}},
		{"llama devices", cardsOf("intel", 3), nil, "--device SYCL2,SYCL0", "llamacpp", "intel", []int{2, 0}},
		{"llama device none is CPU only", two, nil, "-dev none", "llamacpp", "intel", []int{}},
		// Device numbers count what the selector left visible.
		{"llama -mg after selector", cardsOf("intel", 3), sel("level_zero:1,2"), "-sm none -mg 1", "llamacpp", "intel", []int{2}},

		// Selector forms.
		{"wildcard", two, sel("level_zero:*"), "", "llamacpp", "intel", []int{0, 1}},
		{"sub-device is its card", two, sel("level_zero:1.0"), "", "llamacpp", "intel", []int{1}},
		{"exclusion is not inclusion", two, sel("level_zero:*;!level_zero:1"), "", "llamacpp", "intel", []int{0, 1}},
		{"empty selector is unset", two, sel(""), "", "llamacpp", "intel", []int{0, 1}},
		{"ZE_AFFINITY_MASK", two, map[string]string{"ZE_AFFINITY_MASK": "1"}, "", "llamacpp", "", []int{1}},
		{"unknown ordinal still counts", two, sel("level_zero:7"), "", "llamacpp", "intel", []int{0}},

		// Several vendors: the engine's own, or the selector's.
		{"vendor filter", mixed, nil, "", "llamacpp", "nvidia", []int{0, 1}},
		{"cuda selector", mixed, map[string]string{"CUDA_VISIBLE_DEVICES": "1"}, "", "llamacpp", "", []int{1}},
		{"cuda uuid", mixed, map[string]string{"CUDA_VISIBLE_DEVICES": "GPU-0d8f4b2e"}, "", "vllm", "nvidia", []int{0}},
		{"unknown vendor sees all", mixed, nil, "", "other", "", []int{0, 1, 0, 1}},
	}
	for _, c := range cases {
		got := CardsUsed(c.cards, c.env, Split(c.cmd), c.engine, c.vendor)
		if !slices.Equal(ordinals(got), c.want) {
			t.Errorf("%s: cards %v, want %v", c.name, ordinals(got), c.want)
		}
	}

	// The CUDA case picks the NVIDIA card, not the Intel one with the same
	// ordinal.
	got := CardsUsed(mixed, map[string]string{"CUDA_VISIBLE_DEVICES": "1"}, nil, "llamacpp", "")
	if len(got) != 1 || got[0].Vendor != "nvidia" {
		t.Errorf("cuda selector picked %+v", got)
	}
}

func TestSplit(t *testing.T) {
	cmd := `${vllm-intel}
--model ${models-dir}/Qwen/Qwen3.5-9B
# a comment line, as llama-swap allows
  # indented too
--speculative-config '{"method":"mtp","num_speculative_tokens":3}'
--default-chat-template-kwargs "{\"enable_thinking\": false}"
--host 127.0.0.1 --port ${PORT} \
--max-num-seqs 4`
	want := []string{"${vllm-intel}", "--model", "${models-dir}/Qwen/Qwen3.5-9B",
		"--speculative-config", `{"method":"mtp","num_speculative_tokens":3}`,
		"--default-chat-template-kwargs", `{"enable_thinking": false}`,
		"--host", "127.0.0.1", "--port", "${PORT}", "--max-num-seqs", "4"}
	if got := Split(cmd); !slices.Equal(got, want) {
		t.Errorf("Split:\n got %q\nwant %q", got, want)
	}
	if got := Split("a#b c"); !slices.Equal(got, []string{"a#b", "c"}) {
		t.Errorf("a # inside a word is not a comment: %q", got)
	}
}

func TestFlag(t *testing.T) {
	args := Split("--ctx-size 4096 -m a.gguf --ctx-size=8192 --flag")
	if v, ok := Flag(args, "--ctx-size", "-c"); !ok || v != "8192" {
		t.Errorf("last occurrence wins: %q %v", v, ok)
	}
	if v, _ := Flag(args, "--model", "-m"); v != "a.gguf" {
		t.Errorf("alias: %q", v)
	}
	if _, ok := Flag(args, "--flag"); ok {
		t.Error("a switch at the end has no value")
	}
	if !Has(args, "--flag") || Has(args, "--other") {
		t.Error("Has")
	}
}
