package comfy

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSeedWritesBothFilesFresh(t *testing.T) {
	m := &Manager{ComfyDir: t.TempDir()}
	m.Seed()
	hook, err := os.ReadFile(filepath.Join(m.ComfyDir, "storage-user/user-scripts/pre-start.sh"))
	if err != nil || !strings.Contains(string(hook), managedMark) {
		t.Fatalf("pre-start hook not written: %v", err)
	}
	conf, err := os.ReadFile(filepath.Join(m.ComfyDir, "storage-user/user-profile/__manager/config.ini"))
	if err != nil || string(conf) != "[default]\nallow_git_url_install = True\n" {
		t.Fatalf("manager config = %q, %v", conf, err)
	}
}

func TestSeedLeavesSomebodysHookAlone(t *testing.T) {
	m := &Manager{ComfyDir: t.TempDir()}
	path := filepath.Join(m.ComfyDir, "storage-user/user-scripts/pre-start.sh")
	os.MkdirAll(filepath.Dir(path), 0o755)
	own := "#!/bin/bash\necho mine\n"
	os.WriteFile(path, []byte(own), 0o755)
	m.Seed()
	if got, _ := os.ReadFile(path); string(got) != own {
		t.Fatalf("a hook without the mark was rewritten: %q", got)
	}
}

func TestSeedRewritesAManagedHook(t *testing.T) {
	m := &Manager{ComfyDir: t.TempDir()}
	path := filepath.Join(m.ComfyDir, "storage-user/user-scripts/pre-start.sh")
	os.MkdirAll(filepath.Dir(path), 0o755)
	os.WriteFile(path, []byte("#!/bin/bash\n"+managedMark+"\necho old version\n"), 0o755)
	m.Seed()
	if got, _ := os.ReadFile(path); string(got) != preStart {
		t.Fatal("an older managed hook was not brought up to date")
	}
}

func TestSeedAddsFlagUnderDefault(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.ini")
	os.WriteFile(path, []byte("[default]\nsecurity_level = normal\n\n[other]\nx = 1\n"), 0o644)
	if err := seedManagerFlag(path); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	want := "[default]\nallow_git_url_install = True\nsecurity_level = normal\n\n[other]\nx = 1\n"
	if string(got) != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestSeedKeepsAFlagSomebodySetOff(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.ini")
	before := "[default]\nallow_git_url_install = False\n"
	os.WriteFile(path, []byte(before), 0o644)
	if err := seedManagerFlag(path); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(path); string(got) != before {
		t.Fatalf("a flag set off was changed: %q", got)
	}
}

// The extension lands whole -- __init__.py included, which embed would skip
// without all: -- and a second seed rewrites nothing.
func TestSeedFetchNode(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "tenkstack_fetch")
	if err := seedFetchNode(dir); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"__init__.py", "web/fetch.js"} {
		if st, err := os.Stat(filepath.Join(dir, filepath.FromSlash(f))); err != nil || st.Size() == 0 {
			t.Errorf("%s missing: %v", f, err)
		}
	}
	before, _ := os.Stat(filepath.Join(dir, "__init__.py"))
	if err := seedFetchNode(dir); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(filepath.Join(dir, "__init__.py"))
	if !before.ModTime().Equal(after.ModTime()) {
		t.Error("unchanged file was rewritten")
	}
}

// Seed writes the XPU fixes beside the fetch extension, and the pre-start
// hook links them into custom_nodes.
func TestSeedXPUFixes(t *testing.T) {
	m := &Manager{ComfyDir: t.TempDir()}
	m.Seed()
	path := filepath.Join(m.ComfyDir, "storage-user", "user-scripts", filepath.FromSlash(xpuFixesFile))
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Contains(got, []byte("scaled_dot_product_attention")) {
		t.Fatalf("fixes not written: %v", err)
	}
	if !strings.Contains(preStart, "custom_nodes/tenkstack_xpu_fixes.py") && !strings.Contains(preStart, "$NODES/tenkstack_xpu_fixes.py") {
		t.Error("pre-start does not link the fixes")
	}
}
