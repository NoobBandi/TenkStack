package gpu

import (
	"os"
	"path/filepath"
	"testing"
)

// xe's hwmon has two energy counters, the board's labelled card and the
// chip's labelled pkg; the board's is the one with the power limit.
func TestBoardEnergy(t *testing.T) {
	root := t.TempDir()
	hw := filepath.Join(root, "bus", "pci", "devices", "0000:0c:00.0", "hwmon", "hwmon5")
	os.MkdirAll(hw, 0o755)
	for name, text := range map[string]string{
		"energy1_input": "9086914000\n", "energy1_label": "card\n",
		"energy2_input": "5000000000\n", "energy2_label": "pkg\n",
	} {
		os.WriteFile(filepath.Join(hw, name), []byte(text), 0o644)
	}
	if j, ok := BoardEnergy(root, "0000:0c:00.0"); !ok || j != 9086.914 {
		t.Errorf("card counter: %v %v", j, ok)
	}
	if _, ok := BoardEnergy(root, "0000:99:00.0"); ok {
		t.Error("a missing card has a counter")
	}
}
