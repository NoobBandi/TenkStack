package backends

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The goldens were written by the Python module on this machine; the
// scripts must come out byte for byte, since one is already deployed.
func TestWrapperTextMatchesPython(t *testing.T) {
	for _, c := range []struct{ vendor, variant, file string }{
		{"intel", "vendor", "wrapper-intel.sh"},
		{"nvidia", "vendor", "wrapper-nvidia.sh"},
		{"amd", "vulkan", "wrapper-amd-vulkan.sh"},
	} {
		want, err := os.ReadFile(filepath.Join("testdata", c.file))
		if err != nil {
			t.Fatal(err)
		}
		got := WrapperText(c.vendor, "/home/someone/tenkstack/models", c.variant)
		if got != string(want) {
			t.Errorf("%s differs from the Python output:\n--- want\n%s\n--- got\n%s", c.file, want, got)
		}
	}
}

func TestRuntimesTableMatchesPython(t *testing.T) {
	want, err := os.ReadFile(filepath.Join("testdata", "runtimes.json"))
	if err != nil {
		t.Fatal(err)
	}
	var expected map[string]map[string]any
	json.Unmarshal(want, &expected)
	got := Runtimes()
	for vendor, e := range expected {
		g, ok := got[vendor]
		if !ok {
			t.Errorf("%s missing", vendor)
			continue
		}
		gb, _ := json.Marshal(g)
		var gm map[string]any
		json.Unmarshal(gb, &gm)
		delete(gm, "vendor")
		eb, _ := json.Marshal(e)
		gb, _ = json.Marshal(gm)
		if string(eb) != string(gb) {
			t.Errorf("%s: want %s, got %s", vendor, eb, gb)
		}
	}
}
