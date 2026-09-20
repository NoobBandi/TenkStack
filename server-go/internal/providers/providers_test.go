package providers

import "testing"

// The names llama.cpp had before the registry existed are load-bearing:
// a config written then names ${llama-intel} and llama-server-intel.sh.
func TestLlamaCppKeepsItsOldNames(t *testing.T) {
	p, err := Lookup(LlamaCpp)
	if err != nil {
		t.Fatal(err)
	}
	if got := p.Macro("intel"); got != "llama-intel" {
		t.Errorf("macro: got %q", got)
	}
	if got := p.ScriptName("nvidia"); got != "llama-server-nvidia.sh" {
		t.Errorf("script: got %q", got)
	}
	if !p.Serves("gguf") || p.Serves("safetensors") {
		t.Errorf("formats: %v", p.Formats)
	}
}

func TestOtherProvidersNameThemselvesByKey(t *testing.T) {
	p := Provider{Key: "vllm"}
	if got := p.Macro("intel"); got != "vllm-intel" {
		t.Errorf("macro: got %q", got)
	}
	if got := p.ScriptName("intel"); got != "vllm-intel.sh" {
		t.Errorf("script: got %q", got)
	}
}

func TestUnknownKey(t *testing.T) {
	if _, err := Lookup("nope"); err == nil {
		t.Error("expected an error")
	}
}

func TestResolveMacro(t *testing.T) {
	p, vendor, ok := Resolve("vllm-intel")
	if !ok || p.Key != VLLM || vendor != "intel" {
		t.Errorf("vllm-intel: %v %q %v", p.Key, vendor, ok)
	}
	p, vendor, ok = Resolve("llama-nvidia")
	if !ok || p.Key != LlamaCpp || vendor != "nvidia" {
		t.Errorf("llama-nvidia: %v %q %v", p.Key, vendor, ok)
	}
	// A hand-registered native build: llama-sycl is no vendor's macro.
	if _, _, ok := Resolve("llama-sycl"); ok {
		t.Error("llama-sycl should resolve to nothing")
	}
}
