package llamaswap

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
)

// allowTmp lets a test's temporary directories, which live in /tmp, be
// locations.
func allowTmp(t *testing.T) {
	saved := systemDirs
	systemDirs = nil
	for _, d := range saved {
		if d != "/tmp" {
			systemDirs = append(systemDirs, d)
		}
	}
	t.Cleanup(func() { systemDirs = saved })
}

func TestRefRoundTrip(t *testing.T) {
	for _, c := range []struct{ key, rel, ref string }{
		{PrimaryLocation, "a/b/x.gguf", "a/b/x.gguf"},
		{"models-dir-3", "a/b/x.gguf", "${models-dir-3}/a/b/x.gguf"},
	} {
		if got := Ref(c.key, c.rel); got != c.ref {
			t.Errorf("Ref(%s, %s) = %s, want %s", c.key, c.rel, got, c.ref)
		}
		if k, r := SplitRef(c.ref); k != c.key || r != c.rel {
			t.Errorf("SplitRef(%s) = %s, %s", c.ref, k, r)
		}
	}
	// A cmd names the primary through its macro as it always has; the
	// console's name for it stays the bare relative path.
	for raw, want := range map[string]string{
		"${models-dir}/a/x.gguf":   "a/x.gguf",
		"${models-dir-2}/a/x.gguf": "${models-dir-2}/a/x.gguf",
		"${elsewhere}/a/x.gguf":    "a/x.gguf",
		"/abs/path/x.gguf":         "x.gguf",
	} {
		if got := relativeName(raw); got != want {
			t.Errorf("relativeName(%s) = %s, want %s", raw, got, want)
		}
	}
}

// Two locations: a file in each is listed under its own name, an entry can
// be written for the second and read back, and the location it uses cannot
// be removed until the entry is gone.
func TestLocationsEndToEnd(t *testing.T) {
	s, m := tempStore(t)
	allowTmp(t)
	ctx := context.Background()
	m.Prefs = filepath.Join(t.TempDir(), "prefs.json")
	os.MkdirAll(filepath.Join(m.Dir, "o", "r"), 0o755)
	os.WriteFile(filepath.Join(m.Dir, "o", "r", "one.gguf"), []byte("x"), 0o644)

	second := filepath.Join(t.TempDir(), "disk2")
	loc, err := m.AddLocation(ctx, second, "第二顆")
	if err != nil {
		t.Fatal(err)
	}
	if loc.Key != "models-dir-2" || loc.Label != "第二顆" || !loc.Exists {
		t.Fatalf("unexpected location %+v", loc)
	}
	os.MkdirAll(filepath.Join(second, "o", "r"), 0o755)
	os.WriteFile(filepath.Join(second, "o", "r", "two.gguf"), []byte("xy"), 0o644)
	os.MkdirAll(filepath.Join(second, "o", "st"), 0o755)
	os.WriteFile(filepath.Join(second, "o", "st", "config.json"), []byte(`{"torch_dtype":"bfloat16"}`), 0o644)
	os.WriteFile(filepath.Join(second, "o", "st", "model.safetensors"), []byte("z"), 0o644)

	names := map[string]api.GGUFFile{}
	for _, f := range m.ListWeights() {
		names[f.Filename] = f
	}
	if f, ok := names["o/r/one.gguf"]; !ok || f.Location != PrimaryLocation {
		t.Errorf("primary file missing or misplaced: %+v", names)
	}
	if f, ok := names["${models-dir-2}/o/r/two.gguf"]; !ok || f.Location != "models-dir-2" || f.Repo != "o/r" {
		t.Errorf("second file missing or misplaced: %+v", names)
	}
	if f, ok := names["${models-dir-2}/o/st"]; !ok || f.Format != "safetensors" {
		t.Errorf("safetensors dir missing: %+v", names)
	}

	spec := api.ModelSpec{ID: "two", ModelFile: "${models-dir-2}/o/r/two.gguf", CtxSize: 4096, TTL: 60}
	if err := s.Upsert(ctx, spec, nil, nil, ""); err != nil {
		t.Fatal(err)
	}
	raw, _ := s.Raw()
	if !strings.Contains(raw, "--model ${models-dir-2}/o/r/two.gguf\n") {
		t.Errorf("cmd does not name the second location:\n%s", raw)
	}
	if got := m.ReadSpec("two").ModelFile; got != "${models-dir-2}/o/r/two.gguf" {
		t.Errorf("read back %q", got)
	}
	weights := m.Weights()["two"]
	if len(weights) != 1 || !weights[0].Exists || weights[0].SizeBytes != 2 || weights[0].Location != "models-dir-2" {
		t.Errorf("weights of the entry: %+v", weights)
	}
	if err := m.RemoveLocation(ctx, "models-dir-2"); err == nil || !strings.Contains(err.Error(), "two") {
		t.Errorf("a location in use was removed: %v", err)
	}
	if _, err := m.DeleteFile("${models-dir-2}/o/r/two.gguf"); err == nil {
		t.Error("a file in use was deleted")
	}

	if err := m.SetDefaults(map[string]string{"safetensors": "models-dir-2"}); err != nil {
		t.Fatal(err)
	}
	if m.DefaultLocation("safetensors").Key != "models-dir-2" || m.DefaultLocation("gguf").Key != PrimaryLocation {
		t.Error("defaults not kept per format")
	}
	mounts, _ := os.ReadFile(m.mountList())
	if !strings.Contains(string(mounts), realDir(second)) {
		t.Errorf("mount list lacks the new location: %q", mounts)
	}

	if _, err := m.Delete(ctx, "two", false); err != nil {
		t.Fatal(err)
	}
	if err := m.RemoveLocation(ctx, "models-dir-2"); err != nil {
		t.Fatal(err)
	}
	if m.DefaultLocation("safetensors").Key != PrimaryLocation {
		t.Error("a removed location is still a default")
	}
	if _, err := os.Stat(filepath.Join(second, "o", "r", "two.gguf")); err != nil {
		t.Error("removing a location deleted its files")
	}
}

func TestAddLocationRefuses(t *testing.T) {
	_, m := tempStore(t)
	allowTmp(t)
	ctx := context.Background()
	m.Prefs = filepath.Join(t.TempDir(), "prefs.json")
	os.MkdirAll(m.Dir, 0o755)
	comfy := t.TempDir()
	m.Avoid = []string{comfy}
	for _, path := range []string{
		"relative/models",
		"/etc/models",
		"/usr/share/models",
		filepath.Join(t.TempDir(), "has space"),
		filepath.Join(t.TempDir(), "a:b"),
		filepath.Join(m.Dir, "inside"),
		filepath.Dir(m.Dir),
		filepath.Join(comfy, "models"),
	} {
		if _, err := m.AddLocation(ctx, path, ""); err == nil {
			t.Errorf("%s was accepted", path)
		}
	}
	for i := 2; i <= MaxLocations; i++ {
		if _, err := m.AddLocation(ctx, filepath.Join(t.TempDir(), "ok"), ""); err != nil {
			t.Fatalf("location %d refused: %v", i, err)
		}
	}
	if _, err := m.AddLocation(ctx, filepath.Join(t.TempDir(), "sixth"), ""); err == nil {
		t.Error("a sixth location was accepted")
	}
}

// A location can be pointed at another directory only once every file an
// entry loads from it is there; the primary's path is not this to change.
func TestUpdateLocationPath(t *testing.T) {
	s, m := tempStore(t)
	allowTmp(t)
	ctx := context.Background()
	m.Prefs = filepath.Join(t.TempDir(), "prefs.json")
	os.MkdirAll(m.Dir, 0o755)
	old := filepath.Join(t.TempDir(), "old")
	if _, err := m.AddLocation(ctx, old, "舊"); err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(filepath.Join(old, "o", "r"), 0o755)
	os.WriteFile(filepath.Join(old, "o", "r", "w.gguf"), []byte("x"), 0o644)
	if err := s.Upsert(ctx, api.ModelSpec{ID: "w", ModelFile: "${models-dir-2}/o/r/w.gguf", CtxSize: 512}, nil, nil, ""); err != nil {
		t.Fatal(err)
	}

	moved := filepath.Join(t.TempDir(), "new")
	path := moved
	if err := m.UpdateLocation(ctx, "models-dir-2", "新", &path); err == nil || !strings.Contains(err.Error(), "w（o/r/w.gguf）") {
		t.Fatalf("repointed without the entry's file there: %v", err)
	}
	os.MkdirAll(filepath.Join(moved, "o", "r"), 0o755)
	os.WriteFile(filepath.Join(moved, "o", "r", "w.gguf"), []byte("x"), 0o644)
	if err := m.UpdateLocation(ctx, "models-dir-2", "新", &path); err != nil {
		t.Fatal(err)
	}
	loc, _ := m.location("models-dir-2")
	if loc.Path != realDir(moved) {
		t.Errorf("path is %s, want %s", loc.Path, moved)
	}
	if got := m.ListLocationLabels()[1][1]; got != "新" {
		t.Errorf("label is %q", got)
	}
	if abs := m.resolve("${models-dir-2}/o/r/w.gguf"); !strings.HasPrefix(abs, realDir(moved)) {
		t.Errorf("the entry's file resolves to %s", abs)
	}

	primary := filepath.Join(t.TempDir(), "elsewhere")
	if err := m.UpdateLocation(ctx, PrimaryLocation, "", &primary); err == nil {
		t.Error("the primary's path was changed")
	}
	if err := m.UpdateLocation(ctx, PrimaryLocation, "系統碟", nil); err != nil {
		t.Errorf("the primary could not be renamed: %v", err)
	}
}
