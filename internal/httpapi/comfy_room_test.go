package httpapi

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/NoobBandi/TenkStack/internal/api"
	"github.com/NoobBandi/TenkStack/internal/gpu"
	"github.com/NoobBandi/TenkStack/internal/llamaswap"
	"github.com/NoobBandi/TenkStack/internal/settings"
	"github.com/NoobBandi/TenkStack/internal/store/storetest"
)

// busyB70s is the two cards as they were on 2026-10-10 20:13: card 1 with
// 9.4 GiB of idle ComfyUI on it.
type busyB70s struct{ twoB70s }

func (busyB70s) Sample(_ context.Context, index int) (*api.GpuSample, error) {
	used := map[int]float64{0: 1288, 1: 10084}[index]
	return &api.GpuSample{Index: index, MemoryTotalMiB: gpu.Float(32656), MemoryUsedMiB: gpu.Float(used)}, nil
}

// vLLM claims its share of the card at start, so a model whose files would
// fit beside ComfyUI still does not start; llama.cpp needs only its files.
func TestShortCards(t *testing.T) {
	dir := t.TempDir()
	write := func(rel, text string, mode os.FileMode) string {
		p := filepath.Join(dir, rel)
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(text), mode); err != nil {
			t.Fatal(err)
		}
		return p
	}
	vllm := write("llama-swap/vllm-intel.sh", "#!/usr/bin/env bash\nIMAGE=\"${VLLM_IMAGE:-vllm/vllm-openai-xpu:v0.30.0}\"\nexec docker run \"$IMAGE\" \"$@\"\n", 0o755)
	sycl := write("llama-swap/llama-server-sycl.sh", "#!/bin/sh\n", 0o755)
	models := filepath.Join(dir, "models")
	config := write("llama-swap/config.yaml", `macros:
  models-dir: `+models+`
  vllm-intel: `+vllm+`
  llama-sycl: `+sycl+`
models:
  nine:
    cmd: |
      ${vllm-intel}
      --model ${models-dir}/Qwen/Qwen3.5-9B
      --gpu-memory-utilization 0.85
    env:
      - ONEAPI_DEVICE_SELECTOR=level_zero:1
  dual:
    cmd: |
      ${vllm-intel}
      --model ${models-dir}/huihui-ai/x
      --tensor-parallel-size 2
    env:
      - ONEAPI_DEVICE_SELECTOR=level_zero:0,1
  small-gguf:
    cmd: |
      ${llama-sycl}
      --model ${models-dir}/x/small.gguf
  script:
    cmd: /opt/engine/serve.sh ${PORT}
`, 0o644)
	store := llamaswap.NewStore(config)
	s := &Server{Config: store, Models: &llamaswap.Models{Store: store, Dir: models},
		Gpu: gpu.NewRegistry(busyB70s{}), Settings: settings.New(storetest.New(t))}

	for id, want := range map[string]float64{"nine": 0.85, "dual": 0.9, "small-gguf": 0, "missing": 0} {
		if got := s.reservedShare(id); got != want {
			t.Errorf("%s: reserved share %v, want %v", id, got, want)
		}
	}

	ctx := context.Background()
	devices := s.Gpu.ListDevices(ctx)
	if len(devices) != 2 {
		t.Fatalf("devices: %+v", devices)
	}
	card1 := []api.GpuDevice{devices[1]}
	// 22 GiB free, vLLM wants 0.85 of 31.9: ComfyUI has to go.
	if short := s.shortCards(ctx, "nine", card1); len(short) != 1 {
		t.Errorf("9B on vLLM beside ComfyUI: short %+v", short)
	}
	// A script names nothing to size it by: taken to want the whole card.
	if short := s.shortCards(ctx, "script", devices); len(short) != 2 {
		t.Errorf("wrapper script: short %+v", short)
	}
	// A small llama.cpp model fits in what is free.
	if short := s.shortCards(ctx, "small-gguf", card1); len(short) != 0 {
		t.Errorf("small GGUF: short %+v", short)
	}
	// Split over both cards: only the one ComfyUI sits on is short.
	if short := s.shortCards(ctx, "dual", devices); len(short) != 1 || short[0].Index != 1 {
		t.Errorf("dual-card vLLM: short %+v", short)
	}
}
