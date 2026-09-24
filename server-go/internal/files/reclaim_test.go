package files

import (
	"os"
	"path/filepath"
	"testing"
)

// A file in a directory the ComfyUI container made -- root's, so not
// writable here -- is deleted once the directory is taken back, and only
// directories inside the ComfyUI storage are ever taken back.
func TestDeleteTakesBackAComfyDirectory(t *testing.T) {
	comfy := t.TempDir()
	out := filepath.Join(comfy, "storage-user", "output-xpu1")
	locked := filepath.Join(out, "3d")
	if err := os.MkdirAll(locked, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(locked, "mesh.glb"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	os.Chmod(locked, 0o555) // stands in for root's ownership
	t.Cleanup(func() { os.Chmod(locked, 0o755) })
	if writable(locked) {
		t.Skip("running as root: permissions are not enforced")
	}

	var taken []string
	f := &Files{ComfyDir: comfy, Reclaim: func(dir string) error {
		taken = append(taken, dir)
		return os.Chmod(dir, 0o755)
	}}
	if !f.canWrite(Root{}, locked) {
		t.Error("a ComfyUI directory should be offered as writable")
	}
	freed, err := f.Delete("output-xpu1", "3d", "mesh.glb", false)
	if err != nil || !freed.OK {
		t.Fatalf("delete failed: %v", err)
	}
	if len(taken) != 1 || taken[0] != locked {
		t.Errorf("took back %v, want [%s]", taken, locked)
	}

	elsewhere := filepath.Join(t.TempDir(), "mine")
	os.MkdirAll(elsewhere, 0o555)
	t.Cleanup(func() { os.Chmod(elsewhere, 0o755) })
	if f.ensureWritable(elsewhere) || len(taken) != 1 {
		t.Error("a directory outside the ComfyUI storage was taken back")
	}
}
