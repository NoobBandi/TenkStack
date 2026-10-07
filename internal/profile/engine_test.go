package profile

import (
	"testing"

	"github.com/NoobBandi/TenkStack/internal/schema"
)

func TestEngineKey(t *testing.T) {
	macros := map[string]string{
		"llama-sycl":  "/home/someone/ai/llama-swap/llama-server-sycl.sh",
		"llama-intel": "/home/someone/ai/llama-swap/llama-server-intel.sh",
		"vllm-intel":  "/home/someone/ai/llama-swap/vllm-intel.sh",
		"my-engine":   "/home/someone/ai/llama-swap/run.sh",
	}
	cases := []struct {
		cmd, registered, key, vendor, regVendor string
	}{
		// Macros the registry resolves are what it says.
		{"${vllm-intel}\n--model x", "vllm", "vllm", "intel", "intel"},
		{"${llama-intel}\n--model x", "llamacpp", "llamacpp", "intel", "intel"},
		// A native build nobody registered: llama.cpp, on Intel by its name.
		{"${llama-sycl}\n--model x", "", "llamacpp", "intel", ""},
		// A macro no record claims is llama.cpp, as the console treats it,
		// even though it sits beside llama-swap's config.
		{"${my-engine} --model x", "", "llamacpp", "", ""},
		// The Strata entry on the B70 machine.
		{"/home/someone/ai/strata-sycl/llama-swap-serve.sh ${PORT}", "", "strata", "intel", ""},
		{"python3 -m sglang.launch_server --model-path x", "", "sglang", "", ""},
		{"vllm serve Qwen/Qwen3-8B", "", "vllm", "", ""},
		{"/opt/llama.cpp/build/bin/llama-server -m x.gguf", "", "llamacpp", "", ""},
		{"/opt/tgi/run.sh --model x", "", "other", "", ""},
		// A registered engine the workshop has no key for yet.
		{"${trt-nvidia} --model x", "trtllm", "other", "nvidia", "nvidia"},
	}
	for _, c := range cases {
		l := LauncherOf(Split(c.cmd), macros)
		if got := EngineKey(l, c.registered); got != c.key {
			t.Errorf("EngineKey(%q) = %q, want %q", c.cmd, got, c.key)
		}
		if got := VendorOf(l, c.regVendor); got != c.vendor {
			t.Errorf("VendorOf(%q) = %q, want %q", c.cmd, got, c.vendor)
		}
	}
	if l := LauncherOf(Split("${vllm-intel} --x"), macros); l.Macro != "vllm-intel" || l.Path != macros["vllm-intel"] {
		t.Errorf("LauncherOf: %+v", l)
	}
}

func TestImageIn(t *testing.T) {
	console := "#!/usr/bin/env bash\nset -euo pipefail\n\nIMAGE=\"${VLLM_IMAGE:-vllm/vllm-openai-xpu:v0.30.0}\"\nMODELS_DIR=\"/x\"\n"
	if got := ImageIn(console, "VLLM", nil); got != "vllm/vllm-openai-xpu:v0.30.0" {
		t.Errorf("launcher default: %q", got)
	}
	if got := ImageIn(console, "VLLM", map[string]string{"VLLM_IMAGE": "intel/llm-scaler-vllm:0.26.0-b2"}); got != "intel/llm-scaler-vllm:0.26.0-b2" {
		t.Errorf("entry override: %q", got)
	}
	if got := ImageIn("IMAGE=ghcr.io/ggml-org/llama.cpp:server-cuda\nexec docker run \"$IMAGE\"", "", nil); got != "ghcr.io/ggml-org/llama.cpp:server-cuda" {
		t.Errorf("plain assignment: %q", got)
	}
	if got := ImageIn("#!/bin/sh\nsource /opt/intel/oneapi/setvars.sh\nexec llama-server \"$@\"", "LLAMA", nil); got != "" {
		t.Errorf("native launcher: %q", got)
	}
}

func TestEngine(t *testing.T) {
	llamaLabels := map[string]string{
		"org.opencontainers.image.source":  "https://github.com/ggml-org/llama.cpp",
		"org.opencontainers.image.version": "b11176",
	}
	cases := []struct {
		name string
		key  string
		f    EngineFacts
		want schema.EngineRef
	}{
		// The B70 machine's two launchers, as docker describes them.
		{"vllm by tag", VLLM, EngineFacts{Image: "vllm/vllm-openai-xpu:v0.30.0",
			RepoDigests: []string{"vllm/vllm-openai-xpu@sha256:fc0e"}, Labels: map[string]string{"org.opencontainers.image.version": "24.04"},
			Site: "https://github.com/vllm-project/vllm"},
			schema.EngineRef{Key: "vllm", Version: "0.30.0", Image: "vllm/vllm-openai-xpu@sha256:fc0e"}},
		{"llama.cpp by its own label", LlamaCpp, EngineFacts{Image: "ghcr.io/ggml-org/llama.cpp:server-intel",
			RepoDigests: []string{"ghcr.io/ggml-org/llama.cpp@sha256:ef76"}, Labels: llamaLabels, Site: "https://github.com/ggml-org/llama.cpp"},
			schema.EngineRef{Key: "llamacpp", Version: "b11176", Image: "ghcr.io/ggml-org/llama.cpp@sha256:ef76"}},
		// Intel's image labels its own date, not vLLM's version.
		{"inherited label ignored", VLLM, EngineFacts{Image: "intel/llm-scaler-vllm:0.26.0-b2",
			Labels: map[string]string{"org.opencontainers.image.version": "20260608", "org.opencontainers.image.source": "https://github.com/intel/containers"},
			Site:   "https://github.com/vllm-project/vllm"},
			schema.EngineRef{Key: "vllm", Version: "0.26.0-b2", Image: "intel/llm-scaler-vllm:0.26.0-b2"}},
		{"pinned llama tag", LlamaCpp, EngineFacts{Image: "ghcr.io/ggml-org/llama.cpp:server-intel-b11176"},
			schema.EngineRef{Key: "llamacpp", Version: "b11176", Image: "ghcr.io/ggml-org/llama.cpp:server-intel-b11176"}},
		{"rolling tag says nothing", LlamaCpp, EngineFacts{Image: "ghcr.io/ggml-org/llama.cpp:server-intel"},
			schema.EngineRef{Key: "llamacpp", Image: "ghcr.io/ggml-org/llama.cpp:server-intel"}},
		// What a running engine says beats its image.
		{"running llama-server", LlamaCpp, EngineFacts{Image: "ghcr.io/ggml-org/llama.cpp:server-intel", Reported: "b11180-abc1234", Labels: llamaLabels,
			Site: "https://github.com/ggml-org/llama.cpp/"},
			schema.EngineRef{Key: "llamacpp", Version: "b11180", Image: "ghcr.io/ggml-org/llama.cpp:server-intel"}},
		{"native build --version", LlamaCpp, EngineFacts{Reported: "version: 7000 (575bf29)"}, schema.EngineRef{Key: "llamacpp", Version: "b7000"}},
		{"running vllm", VLLM, EngineFacts{Image: "vllm/vllm-openai-xpu:nightly", Reported: "0.30.1.dev12+gabc"},
			schema.EngineRef{Key: "vllm", Version: "0.30.1.dev12+gabc", Image: "vllm/vllm-openai-xpu:nightly"}},
		{"strata checkout", Strata, EngineFacts{Reported: "7ba023e\n"}, schema.EngineRef{Key: "strata", Version: "7ba023e"}},
		{"registry port in the name", VLLM, EngineFacts{Image: "localhost:5000/vllm"}, schema.EngineRef{Key: "vllm", Image: "localhost:5000/vllm"}},
	}
	for _, c := range cases {
		if got := Engine(c.key, c.f); got != c.want {
			t.Errorf("%s:\n got %+v\nwant %+v", c.name, got, c.want)
		}
	}
}

func TestLlamaBuild(t *testing.T) {
	for in, want := range map[string]string{
		"b11176":                                 "b11176",
		"b11176-f805c57":                         "b11176",
		"version: 11176 (f805c57)":               "b11176",
		"version: 7000 (575bf29)\nbuilt with cc": "b7000",
		// A bare commit is not a release number.
		"575bf29-patched": "575bf29-patched",
	} {
		if got := LlamaBuild(in); got != want {
			t.Errorf("LlamaBuild(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDigest(t *testing.T) {
	if got := Digest("a/b:1", []string{"mirror/b@sha256:1", "a/b@sha256:2"}); got != "a/b@sha256:2" {
		t.Errorf("own repo first: %q", got)
	}
	if got := Digest("a/b:1", []string{"mirror/b@sha256:1"}); got != "mirror/b@sha256:1" {
		t.Errorf("any digest is still the content: %q", got)
	}
	if got := Digest("a/b@sha256:9", []string{"a/b@sha256:2"}); got != "a/b@sha256:9" {
		t.Errorf("already pinned: %q", got)
	}
	if got := Digest("a/b:1", nil); got != "a/b:1" {
		t.Errorf("not on this machine: %q", got)
	}
}
