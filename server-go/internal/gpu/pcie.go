package gpu

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
)

// generations names a PCIe generation by its per-lane rate in GT/s.
var generations = []struct {
	rate float64
	name string
}{{2.5, "1.0"}, {5, "2.0"}, {8, "3.0"}, {16, "4.0"}, {32, "5.0"}, {64, "6.0"}}

func generation(rate float64) string {
	for _, g := range generations {
		if rate == g.rate {
			return g.name
		}
	}
	return strconv.FormatFloat(rate, 'f', -1, 64) + " GT/s"
}

// link reads one end of a PCIe link from sysfs: "16.0 GT/s PCIe" and "8".
func link(dir, kind string) (rate float64, width int, ok bool) {
	speed, err1 := os.ReadFile(filepath.Join(dir, kind+"_link_speed"))
	lanes, err2 := os.ReadFile(filepath.Join(dir, kind+"_link_width"))
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	fields := strings.Fields(string(speed))
	if len(fields) == 0 {
		return 0, 0, false
	}
	rate, err1 = strconv.ParseFloat(fields[0], 64)
	width, err2 = strconv.Atoi(strings.TrimSpace(string(lanes)))
	return rate, width, err1 == nil && err2 == nil && rate > 0 && width > 0
}

// PCIeLink is the link between a card and the board, read from sysfs under
// root ("/sys" outside tests).
//
// Not the card's own function: a card with a PCIe switch on it (Arc Pro
// B70 is one) reports the switch's internal x1 link there, which is what
// its vendor tool then shows. The link that decides how fast weights and
// tensors cross is the one into the root port, so the chain is walked up
// to it: the root port's maximum is the slot, the device under it is the
// card's upstream end, whose maximum is what the card can do.
//
// The speed shown is what the two ends can agree on rather than the rate
// right now: cards drop to the slowest rate when idle, and a figure that
// changes with load says nothing about the slot. The width does not drop
// that way, so a narrower link than agreed is reported: a card not fully
// seated, or a slot sharing its lanes.
func PCIeLink(root, bdf string) *api.PCIeLink {
	if bdf == "" {
		return nil
	}
	dir, err := filepath.EvalSymlinks(filepath.Join(root, "bus", "pci", "devices", bdf))
	if err != nil {
		return nil
	}
	var chain []string
	for d := dir; ; d = filepath.Dir(d) {
		if _, _, ok := link(d, "max"); !ok {
			break
		}
		chain = append(chain, d)
	}
	if len(chain) < 2 {
		return nil
	}
	port, card := chain[len(chain)-1], chain[len(chain)-2]
	slotRate, slotWidth, ok1 := link(port, "max")
	cardRate, cardWidth, ok2 := link(card, "max")
	_, nowWidth, ok3 := link(card, "current")
	if !ok1 || !ok2 || !ok3 {
		return nil
	}
	rate, width := min(slotRate, cardRate), min(slotWidth, cardWidth)
	out := &api.PCIeLink{
		Link: fmt.Sprintf("PCIe %s x%d", generation(rate), width),
		Card: fmt.Sprintf("PCIe %s x%d", generation(cardRate), cardWidth),
	}
	out.SlotLimited = rate < cardRate || width < cardWidth
	if nowWidth < width {
		out.NarrowerNow = nowWidth
	}
	return out
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
