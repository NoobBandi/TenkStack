package backends

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/NoobBandi/TenkStack/server-go/internal/providers"
)

// The goldens were first written by the Python module on this machine and
// changed since only where the launchers learnt to mount every model
// location; the legacy-* files are the scripts as they were before that.
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
		got := WrapperText(*providers.Get(providers.LlamaCpp), c.vendor, "/home/someone/tenkstack/models", c.variant)
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
		delete(gm, "provider")
		eb, _ := json.Marshal(e)
		gb, _ = json.Marshal(gm)
		if string(eb) != string(gb) {
			t.Errorf("%s: want %s, got %s", vendor, eb, gb)
		}
	}
}

// A launcher written before model locations, upgraded, is byte for byte
// the one written now; a second pass and an edited script are left alone.
func TestUpgradeMountsMatchesTheTemplate(t *testing.T) {
	dir := t.TempDir()
	cases := []struct{ vendor, variant, file string }{
		{"intel", "vendor", "wrapper-intel.sh"},
		{"nvidia", "vendor", "wrapper-nvidia.sh"},
		{"amd", "vulkan", "wrapper-amd-vulkan.sh"},
	}
	for _, c := range cases {
		old, err := os.ReadFile(filepath.Join("testdata", "legacy-"+c.file))
		if err != nil {
			t.Fatal(err)
		}
		os.WriteFile(filepath.Join(dir, c.file), old, 0o755)
	}
	edited := "#!/usr/bin/env bash\n# somebody's own\nexec docker run -v \"$MODELS_DIR:$MODELS_DIR:ro\" x\n"
	os.WriteFile(filepath.Join(dir, "mine.sh"), []byte(edited), 0o755)

	changed, err := UpgradeMounts(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(changed) != len(cases) {
		t.Errorf("changed %v, want the %d generated scripts", changed, len(cases))
	}
	for _, c := range cases {
		got, _ := os.ReadFile(filepath.Join(dir, c.file))
		want := WrapperText(*providers.Get(providers.LlamaCpp), c.vendor, "/home/someone/tenkstack/models", c.variant)
		if string(got) != want {
			t.Errorf("%s upgraded differs from the template:\n--- want\n%s\n--- got\n%s", c.file, want, got)
		}
		if st, _ := os.Stat(filepath.Join(dir, c.file)); st.Mode().Perm() != 0o755 {
			t.Errorf("%s lost its mode: %v", c.file, st.Mode())
		}
	}
	if mine, _ := os.ReadFile(filepath.Join(dir, "mine.sh")); string(mine) != edited {
		t.Error("a script the console did not write was changed")
	}
	if again, _ := UpgradeMounts(dir); len(again) != 0 {
		t.Errorf("a second pass changed %v", again)
	}
}
