package comfy

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTreeSizeCountsHardLinksOnce(t *testing.T) {
	dir := t.TempDir()
	body := make([]byte, 64*1024)
	if err := os.WriteFile(filepath.Join(dir, "a"), body, 0o644); err != nil {
		t.Fatal(err)
	}
	// The directory's own blocks are in the total, as du counts them, so the
	// comparison is before and after the link rather than against the file.
	before := treeSize(dir)
	if before < int64(len(body)) {
		t.Fatalf("a directory holding one file measured %d, smaller than its %d bytes", before, len(body))
	}
	if err := os.Link(filepath.Join(dir, "a"), filepath.Join(dir, "b")); err != nil {
		t.Skip("hard links unsupported here")
	}
	if after := treeSize(dir); after != before {
		t.Fatalf("adding a hard link changed the total from %d to %d", before, after)
	}
}

func TestTreeSizeOfMissingDirIsZero(t *testing.T) {
	if n := treeSize(filepath.Join(t.TempDir(), "nope")); n != 0 {
		t.Fatalf("got %d for a directory that does not exist", n)
	}
}

func TestSlotOf(t *testing.T) {
	for in, want := range map[string]string{"comfyui-xpu": "xpu", "comfyui-nv0": "nv0", "other": "other"} {
		if got := SlotOf(in); got != want {
			t.Errorf("SlotOf(%q) = %q, want %q", in, got, want)
		}
	}
}
