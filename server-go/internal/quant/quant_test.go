package quant

import (
	"os"
	"path/filepath"
	"testing"
)

// auto-round writes under a name of its own inside the directory it was
// given; the result has to be the directory that was asked for.
func TestFlattenLiftsLoneSubdirectory(t *testing.T) {
	dir := t.TempDir()
	inner := filepath.Join(dir, "Qwen3-8B-fp-w8afp8")
	os.MkdirAll(inner, 0o755)
	os.WriteFile(filepath.Join(inner, "config.json"), []byte("{}"), 0o644)
	os.WriteFile(filepath.Join(inner, "model.safetensors"), []byte("x"), 0o644)
	flatten(dir)
	if _, err := os.Stat(filepath.Join(dir, "config.json")); err != nil {
		t.Fatal("config.json not lifted")
	}
	if _, err := os.Stat(inner); !os.IsNotExist(err) {
		t.Error("inner directory still there")
	}
	// Already flat, or several entries: left alone.
	flatten(dir)
	if _, err := os.Stat(filepath.Join(dir, "model.safetensors")); err != nil {
		t.Error("flat directory disturbed")
	}
}

func TestOutputNamesLikeAPublisher(t *testing.T) {
	if got := Output("Qwen/Qwen3-8B", *SchemeOf("fp8")); got != "Qwen/Qwen3-8B-FP8" {
		t.Errorf("got %q", got)
	}
	if got := Output("Qwen/Qwen3-8B", *SchemeOf("int4")); got != "Qwen/Qwen3-8B-W4A16-AutoRound" {
		t.Errorf("got %q", got)
	}
	if SchemeOf("gguf") != nil {
		t.Error("unknown scheme should be nil")
	}
}

func TestProgressLine(t *testing.T) {
	m := progress.FindStringSubmatch("Quantizing model.layers.12:  36%|███▌      | 13/36 [00:31<00:50,  2.17s/it]")
	if m == nil || m[1] != "13" || m[2] != "36" {
		t.Errorf("got %v", m)
	}
}

func TestSafeName(t *testing.T) {
	for name, ok := range map[string]bool{"Qwen/Qwen3-8B": true, "../etc": false, "/abs": false, "": false} {
		if SafeName(name) != ok {
			t.Errorf("%q: want %v", name, ok)
		}
	}
}
