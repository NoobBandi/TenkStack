package providers

import (
	"strings"
	"testing"
	"testing/fstest"
)

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

// Every record in engines/ loads, and the ones the code names are there
// with what the rest of the console relies on.
func TestRegistry(t *testing.T) {
	all := All()
	if len(all) < 3 || all[0].Key != LlamaCpp || !all[0].Default {
		t.Fatalf("the default engine should come first: %v", keys(all))
	}
	for _, p := range all {
		if data, mime := p.IconData(); len(data) == 0 || mime == "" {
			t.Errorf("%s: no icon", p.Key)
		}
	}
	v := Get(VLLM)
	if v == nil || v.Form != FormServer || v.ModelFlag != "--model" || !v.DropMaxTokens {
		t.Fatalf("vllm record: %+v", v)
	}
	s := Get("sglang")
	if s == nil || s.ServerFlags[FlagContext] != "--context-length" || s.Builds["intel"].Verified {
		t.Errorf("sglang should be a server engine, unverified on Intel: %+v", s)
	}
}

func keys(ps []Provider) []string {
	var out []string
	for _, p := range ps {
		out = append(out, p.Key)
	}
	return out
}

// A record that is incomplete or contradicts itself is refused with a
// reason, which is what a contributor adding an engine sees first.
func TestLoadRefuses(t *testing.T) {
	good := `key: a
name: A
program: a-server
summary: s
site: https://example.com
env_prefix: A
formats: [safetensors]
icon: icon.png
form: server
flags: {model: --model, served_name: --served-model-name, context: --max-model-len}
builds: {intel: {image: x/a}}
`
	def := "key: d\nname: D\nprogram: d\nsummary: s\nsite: https://example.com\nenv_prefix: D\nformats: [gguf]\nicon: icon.png\nform: llama\ndefault: true\nbuilds: {intel: {image: x/d}}\n"
	cases := map[string]string{
		"unknown field":      good + "colour: red\n",
		"key is not the dir": strings.Replace(good, "key: a", "key: b", 1),
		"no such vendor":     strings.Replace(good, "intel:", "quantum:", 1),
		"missing context":    strings.Replace(good, ", context: --max-model-len", "", 1),
		"unknown form":       strings.Replace(good, "form: server", "form: magic", 1),
		"bad format":         strings.Replace(good, "[safetensors]", "[onnx]", 1),
		"flag without --":    strings.Replace(good, "--max-model-len", "max-model-len", 1),
		"bad regexp":         good + "recommended: [{match: \"(\", flags: [--x]}]\n",
		"second default":     good + "default: true\n",
		"missing icon":       strings.Replace(good, "icon.png", "nope.png", 1),
	}
	for name, yaml := range cases {
		files := fstest.MapFS{
			"engines/a/engine.yaml": {Data: []byte(yaml)},
			"engines/a/icon.png":    {Data: []byte("png")},
			"engines/d/engine.yaml": {Data: []byte(def)},
			"engines/d/icon.png":    {Data: []byte("png")},
		}
		if _, err := load(files); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	files := fstest.MapFS{
		"engines/a/engine.yaml": {Data: []byte(good)},
		"engines/a/icon.png":    {Data: []byte("png")},
		"engines/d/engine.yaml": {Data: []byte(def)},
		"engines/d/icon.png":    {Data: []byte("png")},
	}
	all, err := load(files)
	if err != nil {
		t.Fatalf("a good record was refused: %v", err)
	}
	if all[0].Key != "d" || all[1].Managed[0] != "--host" {
		t.Errorf("loaded %+v", all)
	}
}
