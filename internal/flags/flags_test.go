package flags

import (
	"os"
	"slices"
	"strings"
	"testing"
)

// Captured with `docker run --rm --device /dev/dri <image> --help`, which
// loads no model: ghcr.io/ggml-org/llama.cpp:server-intel at f805c57 (the
// image ${llama-intel} runs) and vllm/vllm-openai-xpu:v0.30.0 serve
// --help=all, an argparse help like ComfyUI's.
func load(t *testing.T, name string) map[string]Spec {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]Spec{}
	for _, s := range ParseSpecs(string(b)) {
		for _, n := range s.Names {
			if !strings.HasPrefix(n, "-") {
				t.Errorf("%q is not a flag name (%v)", n, s.Names)
			}
			byName[n] = s
		}
	}
	return byName
}

func TestLlamaServerHelp(t *testing.T) {
	flags := load(t, "llama-server-f805c57.txt")
	for _, c := range []struct {
		name  string
		names []string
		value bool
		env   string
	}{
		// These were once read as switches, so the picker added them
		// without room for the value they need.
		{"-sm", []string{"-sm", "--split-mode"}, true, "LLAMA_ARG_SPLIT_MODE"},
		{"-ts", []string{"-ts", "--tensor-split"}, true, "LLAMA_ARG_TENSOR_SPLIT"},
		{"--rope-scaling", []string{"--rope-scaling"}, true, "LLAMA_ARG_ROPE_SCALING_TYPE"},
		{"-fitt", []string{"-fitt", "--fit-target"}, true, "LLAMA_ARG_FIT_TARGET"},
		// -simple, -mtp, -mod ... in its help were once taken for flags;
		// they are the tails of its choices.
		{"--spec-type", []string{"--spec-type"}, true, "LLAMA_ARG_SPEC_TYPE"},
		{"-c", []string{"-c", "--ctx-size"}, true, "LLAMA_ARG_CTX_SIZE"},
		{"-ngl", []string{"-ngl", "--gpu-layers", "--n-gpu-layers"}, true, "LLAMA_ARG_N_GPU_LAYERS"},
		{"-fa", []string{"-fa", "--flash-attn"}, true, "LLAMA_ARG_FLASH_ATTN"},
		{"--temp", []string{"--temp", "--temperature"}, true, "LLAMA_ARG_TEMPERATURE"},
		{"-kvu", []string{"-kvu", "--kv-unified", "-no-kvu", "--no-kv-unified"}, false, "LLAMA_ARG_KV_UNIFIED"},
		{"--jinja", []string{"--jinja", "--no-jinja"}, false, "LLAMA_ARG_JINJA"},
		{"--spec-draft-model", []string{"--spec-draft-model", "-md", "--model-draft"}, true, "LLAMA_ARG_SPEC_DRAFT_MODEL"},
		{"--no-host", []string{"--no-host"}, false, "LLAMA_ARG_NO_HOST"},
		{"--poll", []string{"--poll"}, true, ""},
	} {
		f, ok := flags[c.name]
		if !ok {
			t.Errorf("%s missing", c.name)
			continue
		}
		if !slices.Equal(f.Names, c.names) || f.TakesValue != c.value || f.Env != c.env {
			t.Errorf("%s = %v value=%v env=%q, want %v value=%v env=%q", c.name, f.Names, f.TakesValue, f.Env, c.names, c.value, c.env)
		}
		if strings.Contains(f.Help, "(env:") {
			t.Errorf("%s help still carries the env note: %q", c.name, f.Help)
		}
	}
	for _, bogus := range []string{"-simple", "-eagle3", "-mtp", "-dflash", "-dspark", "-map-k", "-map-k4v", "-mod", "-cache"} {
		if f, ok := flags[bogus]; ok {
			t.Errorf("%s read as a spelling of %v", bogus, f.Names)
		}
	}
}

func TestArgparseHelp(t *testing.T) {
	flags := load(t, "vllm-serve-v0.30.0.txt")
	for _, c := range []struct {
		name  string
		names []string
		value bool
	}{
		{"-q", []string{"--quantization", "-q"}, true},
		{"-sc", []string{"--speculative-config", "-sc"}, true},
		{"-tp", []string{"--tensor-parallel-size", "-tp"}, true},
		// A head too long for its column sits on a line of its own.
		{"--quantization-config", []string{"--quantization-config"}, true},
		// Its choices run on into prose that names another flag.
		{"--tool-call-parser", []string{"--tool-call-parser"}, true},
		{"--enforce-eager", []string{"--enforce-eager", "--no-enforce-eager"}, false},
		{"--enable-auto-tool-choice", []string{"--enable-auto-tool-choice", "--no-enable-auto-tool-choice"}, false},
		{"-ep", []string{"--enable-expert-parallel", "--no-enable-expert-parallel", "-ep"}, false},
		{"--max-model-len", []string{"--max-model-len"}, true},
	} {
		f, ok := flags[c.name]
		if !ok {
			t.Errorf("%s missing", c.name)
			continue
		}
		if !slices.Equal(f.Names, c.names) || f.TakesValue != c.value {
			t.Errorf("%s = %v value=%v, want %v value=%v", c.name, f.Names, f.TakesValue, c.names, c.value)
		}
	}
	if f, ok := flags["--tool-parser-plugin"]; !ok || !slices.Equal(f.Names, []string{"--tool-parser-plugin"}) {
		t.Errorf("--tool-parser-plugin = %v", f.Names)
	}
}
