package httpapi

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/NoobBandi/TenkStack/internal/api"
	"github.com/NoobBandi/TenkStack/internal/gpu"
	"github.com/NoobBandi/TenkStack/internal/llamaswap"
	"github.com/NoobBandi/TenkStack/internal/schema"
)

// twoB70s is the B70 machine's cards, without xpu-smi.
type twoB70s struct{}

func (twoB70s) Key() string   { return "intel" }
func (twoB70s) Label() string { return "test" }
func (twoB70s) Discover(context.Context) ([]gpu.Device, error) {
	name := "Intel(R) Arc(TM) Pro B70 Graphics"
	return []gpu.Device{{Index: 0, Name: &name}, {Index: 1, Name: &name}}, nil
}
func (twoB70s) Sample(_ context.Context, index int) (*api.GpuSample, error) {
	return &api.GpuSample{Index: index, MemoryTotalMiB: gpu.Float(32656)}, nil
}
func (twoB70s) Detail(context.Context, int) (*api.GpuDetail, error) { return nil, nil }

func TestBenchDescriber(t *testing.T) {
	dir := t.TempDir()
	models := filepath.Join(dir, "models")
	write := func(rel, text string, mode os.FileMode) string {
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(text), mode); err != nil {
			t.Fatal(err)
		}
		return p
	}
	vllm := write("llama-swap/vllm-intel.sh", "#!/usr/bin/env bash\nIMAGE=\"${VLLM_IMAGE:-vllm/vllm-openai-xpu:v0.30.0}\"\nexec docker run \"$IMAGE\" \"$@\"\n", 0o755)
	// A native llama-server build answers --version without loading anything.
	sycl := write("llama-swap/llama-server-sycl.sh", "#!/bin/sh\necho 'version: 7000 (575bf29)'\necho 'built with IntelLLVM'\n", 0o755)
	write("models/Qwen/Qwen3.8-27B/config.json", `{"architectures":["Qwen3_5ForConditionalGeneration"],"torch_dtype":"bfloat16"}`, 0o644)
	config := write("llama-swap/config.yaml", `macros:
  models-dir: `+models+`
  vllm-intel: `+vllm+`
  llama-sycl: `+sycl+`
models:
  fp8-vllm:
    name: Qwen3.8-27B FP8 (vLLM 雙卡)
    cmd: |
      ${vllm-intel}
      --model ${models-dir}/Qwen/Qwen3.8-27B
      --host 127.0.0.1 --port ${PORT}
      --tensor-parallel-size 2
      --quantization fp8
      --speculative-config '{"method":"qwen3_5_mtp","num_speculative_tokens":3}'
    env:
      - ONEAPI_DEVICE_SELECTOR=level_zero:0,1
      - VLLM_NAME=vllm-intel-fp8-vllm
  q6:
    cmd: |
      ${llama-sycl}
      --model ${models-dir}/unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q6_K_XL.gguf
      --port ${PORT}
    env:
      - ONEAPI_DEVICE_SELECTOR=level_zero:1
  strata:
    cmd: `+dir+`/strata-sycl/llama-swap-serve.sh ${PORT}
`, 0o644)
	store := llamaswap.NewStore(config)
	s := &Server{Config: store, Models: &llamaswap.Models{Store: store, Dir: models}, Gpu: gpu.NewRegistry(twoB70s{})}
	describe := BenchDescriber{s}
	ctx := context.Background()

	d, err := describe.Describe(ctx, "fp8-vllm")
	if err != nil {
		t.Fatal(err)
	}
	if d.ModelID != "fp8-vllm" || d.Name != "Qwen3.8-27B FP8 (vLLM 雙卡)" || d.Command == "" {
		t.Errorf("identity: %q %q %q", d.ModelID, d.Name, d.Command)
	}
	wantGPU := schema.GPU{Vendor: "intel", Model: "Intel Arc Pro B70", VRAMMiB: 32656, Count: 2}
	if d.Hardware.GPU != wantGPU {
		t.Errorf("gpu: %+v", d.Hardware.GPU)
	}
	// bf16 on disk; the online fp8 is tuning, not the model.
	if want := (schema.ModelRef{Format: "safetensors", Repo: "Qwen/Qwen3.8-27B", Quant: "bf16"}); d.Model != want {
		t.Errorf("model: %+v", d.Model)
	}
	if want := (schema.EngineRef{Key: "vllm", Version: "0.30.0", Image: "vllm/vllm-openai-xpu:v0.30.0"}); d.Engine != want {
		t.Errorf("engine: %+v", d.Engine)
	}
	// The launch command read into parameters; the fp8 shows up here.
	if d.Tuning.OnlineQuantization == nil || *d.Tuning.OnlineQuantization != "fp8" {
		t.Errorf("tuning: %+v", d.Tuning)
	}

	d, err = describe.Describe(ctx, "q6")
	if err != nil {
		t.Fatal(err)
	}
	if d.Hardware.GPU.Count != 1 || d.Name != "q6" {
		t.Errorf("one card, named by its id: %+v %q", d.Hardware.GPU, d.Name)
	}
	if d.Model.Quant != "UD-Q6_K_XL" || d.Model.Repo != "unsloth/Qwen3.8-27B-GGUF" {
		t.Errorf("gguf: %+v", d.Model)
	}
	if want := (schema.EngineRef{Key: "llamacpp", Version: "b7000"}); d.Engine != want {
		t.Errorf("native llama.cpp: %+v", d.Engine)
	}

	// A script that picks its own model: the engine and the cards are
	// still known, the model is not.
	d, err = describe.Describe(ctx, "strata")
	if err != nil {
		t.Fatal(err)
	}
	if d.Engine.Key != "strata" || d.Hardware.GPU.Count != 2 || d.Model != (schema.ModelRef{}) {
		t.Errorf("strata: %+v %+v %+v", d.Engine, d.Hardware.GPU, d.Model)
	}

	if _, err := describe.Describe(ctx, "missing"); err == nil {
		t.Error("an unknown model is an error")
	}
}
