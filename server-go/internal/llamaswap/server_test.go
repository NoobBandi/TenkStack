package llamaswap

import (
	"context"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
)

// A vLLM entry round-trips through the same writer and reader as a
// llama.cpp one, carries the container's name for cmdStop, and counts its
// weights as a directory.
// compileFlag is a flag whose value is quoted JSON, the way an entry turns on
// XPU graphs; it has to come back byte for byte.
const compileFlag = `--compilation-config '{"cudagraph_mode":"FULL_DECODE_ONLY","splitting_ops":["vllm::all_reduce"]}'`

func TestVLLMEntryRoundTrip(t *testing.T) {
	s, m := tempStore(t)
	ctx := context.Background()
	if err := s.AddMacro(ctx, "vllm-intel", "/somewhere/vllm-intel.sh"); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(m.Dir, "Qwen", "Qwen3-8B")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "config.json"), []byte("{}"), 0o644)
	os.WriteFile(filepath.Join(dir, "model-00001-of-00002.safetensors"), make([]byte, 1000), 0o644)
	os.WriteFile(filepath.Join(dir, "model-00002-of-00002.safetensors"), make([]byte, 500), 0o644)

	spec := api.ModelSpec{ID: "qwen3-8b", Name: "Qwen3 8B", ModelFile: "Qwen/Qwen3-8B", CtxSize: 32768,
		TTL: 300, Group: strp("large"), Runtime: "vllm-intel", Quantization: "fp8", GpuMemoryUtilization: 0.85,
		Extra: "--enable-prefix-caching\n" + compileFlag + "\n"}
	err := s.Upsert(ctx, spec, map[string]string{"ONEAPI_DEVICE_SELECTOR": "level_zero:0,1"},
		map[string]bool{"ONEAPI_DEVICE_SELECTOR": true}, "${vllm-intel}")
	if err != nil {
		t.Fatal(err)
	}
	out, _ := s.Raw()
	for _, want := range []string{
		"    cmd: |\n      ${vllm-intel}\n      --model ${models-dir}/Qwen/Qwen3-8B\n      --served-model-name qwen3-8b\n",
		"      --max-model-len 32768\n      --tensor-parallel-size 2\n      --gpu-memory-utilization 0.85\n      --quantization fp8\n      --enable-prefix-caching\n      " + compileFlag + "\n",
		"    cmdStop: docker stop vllm-intel-qwen3-8b\n",
		"      - ONEAPI_DEVICE_SELECTOR=level_zero:0,1\n      - VLLM_NAME=vllm-intel-qwen3-8b\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}

	read := m.ReadSpec("qwen3-8b")
	if read == nil || read.Provider != "vllm" || read.Runtime != "vllm-intel" || read.Format != "safetensors" ||
		read.ModelFile != "Qwen/Qwen3-8B" || read.CtxSize != 32768 || read.Quantization != "fp8" ||
		read.GpuMemoryUtilization != 0.85 || read.Extra != "--enable-prefix-caching\n"+compileFlag {
		t.Errorf("ReadSpec = %+v", read)
	}
	if got := m.ContextSizes()["qwen3-8b"]; got != 32768 {
		t.Errorf("context size %d", got)
	}

	// The directory is one set of weights, sized as its contents.
	weights := m.Weights()["qwen3-8b"]
	if len(weights) != 1 || weights[0].Filename != "Qwen/Qwen3-8B" || weights[0].SizeBytes != 1502 || !weights[0].Exists {
		t.Errorf("weights = %+v", weights)
	}
	var listed *api.GGUFFile
	for _, f := range m.ListWeights() {
		if f.Format == "safetensors" {
			f := f
			listed = &f
		}
	}
	if listed == nil || listed.Filename != "Qwen/Qwen3-8B" || listed.SizeBytes != 1502 || len(listed.UsedBy) != 1 {
		t.Errorf("listed = %+v", listed)
	}

	// An edit that names no card keeps the card count it had.
	spec.CtxSize = 16384
	if err := s.Upsert(ctx, spec, nil, nil, ""); err != nil {
		t.Fatal(err)
	}
	out, _ = s.Raw()
	if !strings.Contains(out, "--max-model-len 16384\n      --tensor-parallel-size 2\n") {
		t.Errorf("tensor parallel lost on edit:\n%s", out)
	}

	// Deleting takes the directory with it.
	result, err := m.Delete(ctx, "qwen3-8b", true)
	if err != nil || result == nil || len(result.Deleted) != 1 || result.Deleted[0].SizeBytes != 1502 {
		t.Fatalf("delete = %+v, %v", result, err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Error("directory still there")
	}
}

// Moving an entry from a container launcher to a native one drops the
// stop command that would now stop nothing.
func TestNativeLauncherDropsDockerStop(t *testing.T) {
	s, _ := tempStore(t)
	ctx := context.Background()
	s.AddMacro(ctx, "llama-nvidia", "/somewhere/llama-server-nvidia.sh")
	spec := api.ModelSpec{ID: "tiny", ModelFile: "tiny.gguf", CtxSize: 4096, TTL: 60, NGpuLayers: 99}
	if err := s.Upsert(ctx, spec, map[string]string{}, nil, "${llama-nvidia}"); err != nil {
		t.Fatal(err)
	}
	out, _ := s.Raw()
	if !strings.Contains(out, "cmdStop: docker stop llama-nvidia-tiny\n") || !strings.Contains(out, "LLAMA_NAME=llama-nvidia-tiny") {
		t.Errorf("container launcher not named:\n%s", out)
	}
	if err := s.Upsert(ctx, spec, map[string]string{}, nil, "${llama-sycl}"); err != nil {
		t.Fatal(err)
	}
	out, _ = s.Raw()
	if strings.Contains(out, "cmdStop") || strings.Contains(out, "LLAMA_NAME") {
		t.Errorf("stale container bits kept:\n%s", out)
	}
}

// An orphan directory of weights is deleted like an orphan GGUF, and one a
// model names is refused.
func TestDeleteWeightDirectory(t *testing.T) {
	s, m := tempStore(t)
	dir := filepath.Join(m.Dir, "Org", "Model")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "config.json"), []byte("{}"), 0o644)
	os.WriteFile(filepath.Join(dir, "model.safetensors"), make([]byte, 100), 0o644)
	// The publisher's directory is not a model; deleting it would take
	// every model under it.
	if _, err := m.DeleteFile("Org"); err == nil {
		t.Error("deleting a parent directory should be refused")
	}
	ctx := context.Background()
	s.AddMacro(ctx, "vllm-intel", "/somewhere/vllm-intel.sh")
	spec := api.ModelSpec{ID: "m", ModelFile: "Org/Model", CtxSize: 4096, TTL: 60}
	if err := s.Upsert(ctx, spec, map[string]string{}, nil, "${vllm-intel}"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.DeleteFile("Org/Model"); err == nil || !strings.Contains(err.Error(), "仍被 m 使用") {
		t.Errorf("in-use directory: %v", err)
	}
	m.Delete(ctx, "m", false)
	got, err := m.DeleteFile("Org/Model")
	if err != nil || got.SizeBytes != 102 {
		t.Fatalf("delete = %+v, %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(m.Dir, "Org")); !os.IsNotExist(err) {
		t.Error("empty parent left behind")
	}
}

func TestPrecisionOf(t *testing.T) {
	dir := t.TempDir()
	write := func(cfg string) {
		os.WriteFile(filepath.Join(dir, "config.json"), []byte(cfg), 0o644)
	}
	for _, c := range []struct {
		cfg       string
		precision string
		quantized bool
	}{
		{`{"torch_dtype": "bfloat16"}`, "bf16", false},
		{`{"dtype": "float16"}`, "fp16", false},
		{`{"architectures": ["Qwen3_5ForConditionalGeneration"], "text_config": {"dtype": "bfloat16"}}`, "bf16", false},
		{`{"torch_dtype": "bfloat16", "quantization_config": {"quant_method": "fp8", "activation_scheme": "dynamic"}}`, "fp8", true},
		{`{"quantization_config": {"quant_method": "awq", "bits": 4}}`, "awq", true},
		{`{"quantization_config": {"quant_method": "gptq", "bits": 4}}`, "gptq", true},
		{`{"quantization_config": {"quant_method": "compressed-tensors", "config_groups": {"group_0": {"weights": {"type": "int", "num_bits": 4}}}}}`, "int4", true},
		{`{"quantization_config": {"quant_method": "compressed-tensors", "config_groups": {"group_0": {"weights": {"type": "float", "num_bits": 8}}}}}`, "fp8", true},
		{`{"quantization_config": {"quant_method": "mxfp4"}}`, "mxfp4", true},
	} {
		write(c.cfg)
		p, q := precisionOf(dir)
		if p != c.precision || q != c.quantized {
			t.Errorf("%s: got %q %v, want %q %v", c.cfg, p, q, c.precision, c.quantized)
		}
	}
}

// A split GGUF is its shards: all of them count as used, sizes add up,
// and the entry shows one row for them.
func TestSplitGGUFIsItsShards(t *testing.T) {
	if got := shardsOf("unsloth/X/M-00001-of-00003.gguf"); len(got) != 3 || got[2] != "unsloth/X/M-00003-of-00003.gguf" {
		t.Errorf("shards = %v", got)
	}
	if got := shardsOf("plain.gguf"); len(got) != 1 {
		t.Errorf("plain = %v", got)
	}
	s, m := tempStore(t)
	dir := filepath.Join(m.Dir, "unsloth", "X")
	os.MkdirAll(dir, 0o755)
	for i, n := range []int{10, 200, 300} {
		os.WriteFile(filepath.Join(dir, fmt.Sprintf("M-%05d-of-00003.gguf", i+1)), make([]byte, n), 0o644)
	}
	spec := api.ModelSpec{ID: "big", ModelFile: "unsloth/X/M-00001-of-00003.gguf", CtxSize: 4096, TTL: 60, NGpuLayers: 99}
	if err := s.Upsert(context.Background(), spec, map[string]string{}, nil, ""); err != nil {
		t.Fatal(err)
	}
	w := m.Weights()["big"]
	if len(w) != 1 || w[0].SizeBytes != 510 || w[0].Parts != 3 || !w[0].Exists {
		t.Errorf("weights = %+v", w)
	}
	for _, f := range m.ListGGUF() {
		if len(f.UsedBy) == 0 && strings.HasPrefix(path.Base(f.Filename), "M-") {
			t.Errorf("%s listed as unused", f.Filename)
		}
	}
}

// A second server engine goes through the same form under its own
// spelling, read from its record: SGLang's --model-path, --context-length,
// --tp-size and --mem-fraction-static.
func TestSGLangEntryRoundTrip(t *testing.T) {
	s, m := tempStore(t)
	ctx := context.Background()
	if err := s.AddMacro(ctx, "sglang-intel", "/somewhere/sglang-intel.sh"); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(m.Dir, "Qwen", "Qwen3-8B")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "config.json"), []byte("{}"), 0o644)
	os.WriteFile(filepath.Join(dir, "model.safetensors"), make([]byte, 100), 0o644)

	spec := api.ModelSpec{ID: "qwen3-8b-sg", ModelFile: "Qwen/Qwen3-8B", CtxSize: 32768, TTL: 300,
		Runtime: "sglang-intel", GpuMemoryUtilization: 0.8, Extra: "--reasoning-parser qwen3\n"}
	err := s.Upsert(ctx, spec, map[string]string{"ONEAPI_DEVICE_SELECTOR": "level_zero:0,1"},
		map[string]bool{"ONEAPI_DEVICE_SELECTOR": true}, "${sglang-intel}")
	if err != nil {
		t.Fatal(err)
	}
	out, _ := s.Raw()
	for _, want := range []string{
		"      ${sglang-intel}\n      --model-path ${models-dir}/Qwen/Qwen3-8B\n      --served-model-name qwen3-8b-sg\n",
		"      --context-length 32768\n      --tp-size 2\n      --mem-fraction-static 0.8\n      --reasoning-parser qwen3\n",
		"    cmdStop: docker stop sglang-intel-qwen3-8b-sg\n",
		"      - SGLANG_NAME=sglang-intel-qwen3-8b-sg\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	read := m.ReadSpec("qwen3-8b-sg")
	if read == nil || read.Provider != "sglang" || read.ModelFile != "Qwen/Qwen3-8B" || read.CtxSize != 32768 ||
		read.GpuMemoryUtilization != 0.8 || read.Extra != "--reasoning-parser qwen3" {
		t.Errorf("ReadSpec = %+v", read)
	}
	if got := m.ContextSizes()["qwen3-8b-sg"]; got != 32768 {
		t.Errorf("context size %d", got)
	}
	if w := m.Weights()["qwen3-8b-sg"]; len(w) != 1 || w[0].Filename != "Qwen/Qwen3-8B" {
		t.Errorf("weights = %+v", w)
	}
}
