package gpu

import (
	"os"
	"path/filepath"
	"testing"
)

// fakeLink writes one PCI device's link files.
func fakeLink(t *testing.T, dir, maxSpeed, maxWidth, curSpeed, curWidth string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, v := range map[string]string{
		"max_link_speed": maxSpeed, "max_link_width": maxWidth,
		"current_link_speed": curSpeed, "current_link_width": curWidth,
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(v+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func linkTo(t *testing.T, root, bdf, target string) {
	t.Helper()
	devices := filepath.Join(root, "bus", "pci", "devices")
	if err := os.MkdirAll(devices, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(devices, bdf)); err != nil {
		t.Fatal(err)
	}
}

// An Arc Pro B70 in a PCIe 4.0 x8 slot, as this machine has it: the card's
// own function says x1 at 2.5 GT/s, behind the switch on the card.
func TestPCIeLinkBehindCardSwitch(t *testing.T) {
	root := t.TempDir()
	port := filepath.Join(root, "devices", "pci0000:00", "0000:00:03.1")
	up := filepath.Join(port, "0000:0a:00.0")
	down := filepath.Join(up, "0000:0b:01.0")
	fn := filepath.Join(down, "0000:0c:00.0")
	fakeLink(t, port, "16.0 GT/s PCIe", "8", "16.0 GT/s PCIe", "8")
	fakeLink(t, up, "32.0 GT/s PCIe", "16", "16.0 GT/s PCIe", "8")
	fakeLink(t, down, "2.5 GT/s PCIe", "1", "2.5 GT/s PCIe", "1")
	fakeLink(t, fn, "2.5 GT/s PCIe", "1", "2.5 GT/s PCIe", "1")
	linkTo(t, root, "0000:0c:00.0", fn)

	got := PCIeLink(root, "0000:0c:00.0")
	if got == nil || got.Link != "PCIe 4.0 x8" || got.Card != "PCIe 5.0 x16" || !got.SlotLimited || got.NarrowerNow != 0 {
		t.Fatalf("got %+v", got)
	}
}

// A card straight under the root port, idling at the lowest rate in a slot
// that gives it only four of its sixteen lanes.
func TestPCIeLinkIdleAndNarrow(t *testing.T) {
	root := t.TempDir()
	port := filepath.Join(root, "devices", "pci0000:00", "0000:00:01.1")
	fn := filepath.Join(port, "0000:01:00.0")
	fakeLink(t, port, "16.0 GT/s PCIe", "16", "2.5 GT/s PCIe", "4")
	fakeLink(t, fn, "16.0 GT/s PCIe", "16", "2.5 GT/s PCIe", "4")
	linkTo(t, root, "0000:01:00.0", fn)

	got := PCIeLink(root, "0000:01:00.0")
	if got == nil || got.Link != "PCIe 4.0 x16" || got.SlotLimited || got.NarrowerNow != 4 {
		t.Fatalf("got %+v", got)
	}
}

func TestPCIeLinkUnknownDevice(t *testing.T) {
	if got := PCIeLink(t.TempDir(), "0000:99:00.0"); got != nil {
		t.Fatalf("got %+v", got)
	}
}
