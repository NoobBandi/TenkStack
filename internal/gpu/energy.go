package gpu

import (
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// BoardEnergy is the energy a card has used since its driver loaded, in
// joules, from the driver's hwmon counter for the whole board: the one
// labelled "card" (xe labels its two card and pkg, the chip alone), else
// the only one there is. ok is false for a card with no such counter.
//
// The counter, read often, is the card's power at any resolution: xpu-smi
// and the console's history report power averaged over a second or more,
// which smooths a card that touches its 230 W limit in bursts down to 200.
func BoardEnergy(root, bdf string) (joules float64, ok bool) {
	path := boardEnergyPath(root, bdf)
	if path == "" {
		return 0, false
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	uj, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	if err != nil {
		return 0, false
	}
	return float64(uj) / 1e6, true
}

// boardEnergyPath is the hwmon file BoardEnergy reads, "" when the card
// has none.
func boardEnergyPath(root, bdf string) string {
	if bdf == "" {
		return ""
	}
	dirs, _ := filepath.Glob(filepath.Join(root, "bus", "pci", "devices", bdf, "hwmon", "hwmon*"))
	for _, dir := range dirs {
		inputs, _ := filepath.Glob(filepath.Join(dir, "energy*_input"))
		sort.Strings(inputs)
		for _, in := range inputs {
			label, _ := os.ReadFile(strings.TrimSuffix(in, "_input") + "_label")
			if strings.TrimSpace(string(label)) == "card" {
				return in
			}
		}
		if len(inputs) == 1 {
			return inputs[0]
		}
	}
	return ""
}
