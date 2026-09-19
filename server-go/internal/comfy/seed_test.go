package comfy

import (
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
