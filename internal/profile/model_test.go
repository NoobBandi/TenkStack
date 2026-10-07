package profile

import (
	"testing"

	"github.com/NoobBandi/TenkStack/internal/locations"
	"github.com/NoobBandi/TenkStack/internal/schema"
)

var (
	testMacros = map[string]string{
		"models-dir":   "/home/someone/ai/models",
		"models-dir-2": "/home/someone/Documents/models",
		"vllm-intel":   "/home/someone/ai/llama-swap/vllm-intel.sh",
	}
	testLocs = []locations.Location{
		{Key: "models-dir", Path: "/home/someone/ai/models"},
		{Key: "models-dir-2", Path: "/home/someone/Documents/models/"},
	}
)

func TestModelArg(t *testing.T) {
	for cmd, want := range map[string]string{
		"${llama-intel} --model ${models-dir}/a/b/c.gguf --port ${PORT}": "${models-dir}/a/b/c.gguf",
		"llama-server -m /m/x.gguf":                                      "/m/x.gguf",
		"python3 -m sglang.launch_server --model-path Qwen/Q":            "Qwen/Q",
		"vllm serve ${models-dir}/Qwen/Qwen3-8B --port 1":                "${models-dir}/Qwen/Qwen3-8B",
		"/home/someone/ai/strata-sycl/llama-swap-serve.sh ${PORT}":       "",
	} {
		if got := ModelArg(Split(cmd)); got != want {
			t.Errorf("ModelArg(%q) = %q, want %q", cmd, got, want)
		}
	}
}

func TestModel(t *testing.T) {
	none := ModelFacts{FileType: -1}
	cases := []struct {
		name  string
		raw   string
		facts ModelFacts
		want  schema.ModelRef
	}{
		// The B70 machine's entries.
		{"vllm bf16 served as online fp8 is still bf16", "${models-dir}/huihui-ai/Huihui-Qwen3.8-27B-abliterated",
			ModelFacts{Precision: "bf16", FileType: -1},
			schema.ModelRef{Format: "safetensors", Repo: "huihui-ai/Huihui-Qwen3.8-27B-abliterated", Quant: "bf16"}},
		{"vllm published fp8", "${models-dir}/Qwen/Qwen3.6-35B-A3B-FP8", ModelFacts{Precision: "fp8", FileType: -1},
			schema.ModelRef{Format: "safetensors", Repo: "Qwen/Qwen3.6-35B-A3B-FP8", Quant: "fp8"}},
		{"gguf", "${models-dir}/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF/Huihui-Qwen3.8-27B-abliterated-UD-Q6_K_XL.gguf", none,
			schema.ModelRef{Format: "gguf", Repo: "huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF",
				File: "Huihui-Qwen3.8-27B-abliterated-UD-Q6_K_XL.gguf", Quant: "UD-Q6_K_XL"}},
		{"split gguf in a quant directory", "${models-dir}/unsloth/Qwen3.8-Flash-Next-GGUF/UD-IQ3_XXS/Qwen3.8-Flash-Next-UD-IQ3_XXS-00001-of-00003.gguf", none,
			schema.ModelRef{Format: "gguf", Repo: "unsloth/Qwen3.8-Flash-Next-GGUF",
				File: "UD-IQ3_XXS/Qwen3.8-Flash-Next-UD-IQ3_XXS-00001-of-00003.gguf", Quant: "UD-IQ3_XXS"}},

		// Other locations, by macro and by the path they expand to.
		{"second location", "${models-dir-2}/Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf", none,
			schema.ModelRef{Format: "gguf", Repo: "Qwen/Qwen3-8B-GGUF", File: "Qwen3-8B-Q4_K_M.gguf", Quant: "Q4_K_M"}},
		{"absolute path inside a location", "/home/someone/Documents/models/Qwen/Qwen3-8B", ModelFacts{Precision: "BF16", FileType: -1},
			schema.ModelRef{Format: "safetensors", Repo: "Qwen/Qwen3-8B", Quant: "bf16"}},

		// Not laid out as owner/repo: no repo, never a path.
		{"file at a location's root", "${models-dir}/small-q4.gguf", none,
			schema.ModelRef{Format: "gguf", File: "small-q4.gguf", Quant: ""}},
		{"absolute path elsewhere", "/opt/weights/my-model-Q8_0.gguf", none,
			schema.ModelRef{Format: "gguf", File: "my-model-Q8_0.gguf", Quant: "Q8_0"}},
		{"directory too deep for a repo", "${models-dir}/hf/Qwen/Qwen3-8B", ModelFacts{Precision: "bf16", FileType: -1},
			schema.ModelRef{Format: "safetensors", Quant: "bf16"}},
		{"directory elsewhere", "/srv/llm/qwen", ModelFacts{Precision: "bf16", FileType: -1},
			schema.ModelRef{Format: "safetensors", Quant: "bf16"}},
		{"unknown macro", "${somewhere}/a/b/c-Q4_0.gguf", none,
			schema.ModelRef{Format: "gguf", File: "c-Q4_0.gguf", Quant: "Q4_0"}},
		{"escaping a location", "${models-dir}/../../etc/x", none,
			schema.ModelRef{Format: "safetensors"}},

		// The Hugging Face cache names the repo and the commit itself.
		{"hub cache", "/home/someone/.cache/huggingface/hub/models--Qwen--Qwen3-8B/snapshots/0123456789abcdef0123456789abcdef01234567", ModelFacts{Precision: "bf16", FileType: -1},
			schema.ModelRef{Format: "safetensors", Repo: "Qwen/Qwen3-8B", Revision: "0123456789abcdef0123456789abcdef01234567", Quant: "bf16"}},
		{"hub cache gguf", "/c/hub/models--unsloth--Qwen3-8B-GGUF/snapshots/0123456789abcdef0123456789abcdef01234567/Qwen3-8B-Q6_K.gguf", none,
			schema.ModelRef{Format: "gguf", Repo: "unsloth/Qwen3-8B-GGUF", File: "Qwen3-8B-Q6_K.gguf",
				Revision: "0123456789abcdef0123456789abcdef01234567", Quant: "Q6_K"}},

		// The header answers when the name does not; recorded digests pass.
		{"header file type", "${models-dir}/a/b/model.gguf", ModelFacts{FileType: 15, SHA256: "ab12"},
			schema.ModelRef{Format: "gguf", Repo: "a/b", File: "model.gguf", SHA256: "ab12", Quant: "Q4_K_M"}},
		{"strata: nothing on the command line", "", none, schema.ModelRef{}},
	}
	for _, c := range cases {
		if got := Model(c.raw, testMacros, testLocs, c.facts); got != c.want {
			t.Errorf("%s:\n got %+v\nwant %+v", c.name, got, c.want)
		}
	}
}

func TestLocate(t *testing.T) {
	cases := []struct {
		raw, key, rel string
		ok            bool
	}{
		{"${models-dir}/a/b.gguf", "models-dir", "a/b.gguf", true},
		{"${models-dir-2}/a/b", "models-dir-2", "a/b", true},
		{"/home/someone/Documents/models/x/y", "models-dir-2", "x/y", true},
		{"/home/someone/ai/models", "", "", false},
		{"/home/someone/ai/models-old/x", "", "", false},
		{"relative/x", "", "", false},
	}
	for _, c := range cases {
		key, rel, ok := Locate(c.raw, testMacros, testLocs)
		if key != c.key || rel != c.rel || ok != c.ok {
			t.Errorf("Locate(%q) = %q %q %v, want %q %q %v", c.raw, key, rel, ok, c.key, c.rel, c.ok)
		}
	}
}

func TestGGUFQuant(t *testing.T) {
	for name, want := range map[string]string{
		"Huihui-Qwen3.8-27B-abliterated-UD-Q6_K_XL.gguf":                           "UD-Q6_K_XL",
		"Huihui-Qwen3.8-27B-abliterated-UD-Q8_K_XL.gguf":                           "UD-Q8_K_XL",
		"UD-IQ3_XXS/Qwen3.8-Flash-Next-UD-IQ3_XXS-00001-of-00003.gguf":             "UD-IQ3_XXS",
		"Q4_K_M/model-00001-of-00002.gguf":                                         "Q4_K_M",
		"qwen2.5-7b-instruct-q4_k_m.gguf":                                          "Q4_K_M",
		"Qwen3-30B-A3B-Q8_0.gguf":                                                  "Q8_0",
		"gemma-3-27b-it-qat-q4_0.gguf":                                             "Q4_0",
		"Llama-3.2-3B-Instruct-IQ4_XS.gguf":                                        "IQ4_XS",
		"Llama-3.2-3B-Instruct-f16.gguf":                                           "F16",
		"mmproj-model-bf16.gguf":                                                   "BF16",
		"gpt-oss-20b-MXFP4.gguf":                                                   "MXFP4",
		"Qwen3-Coder-30B-A3B-Instruct-1M-UD-Q4_K_XL.gguf":                          "UD-Q4_K_XL",
		"DeepSeek-R1-0528-Qwen3-8B-BF16-Q8_0.gguf":                                 "Q8_0",
		"Phi-3-mini-4k-instruct.gguf":                                              "",
		"/abs/path/to/Qwen3-8B-Q5_K_S.gguf":                                        "Q5_K_S",
		"${models-dir}/unsloth/X-GGUF/UD-Q2_K_XL/X-UD-Q2_K_XL-00001-of-00005.gguf": "UD-Q2_K_XL",
	} {
		if got := GGUFQuant(name, -1); got != want {
			t.Errorf("GGUFQuant(%q) = %q, want %q", name, got, want)
		}
	}
	if got := GGUFQuant("model.gguf", 18); got != "Q6_K" {
		t.Errorf("header fallback: %q", got)
	}
	if got := GGUFQuant("model-Q4_K_M.gguf", 18); got != "Q4_K_M" {
		t.Errorf("the name wins over the header: %q", got)
	}
}

func TestPrecision(t *testing.T) {
	if got := Precision([]byte(`{"architectures":["Qwen3ForCausalLM"],"torch_dtype":"bfloat16"}`)); got != "bf16" {
		t.Errorf("bf16: %q", got)
	}
	if got := Precision([]byte(`{"quantization_config":{"quant_method":"fp8"},"torch_dtype":"bfloat16"}`)); got != "fp8" {
		t.Errorf("fp8: %q", got)
	}
}
