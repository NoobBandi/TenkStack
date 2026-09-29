package setup

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Card is one display device, read from PCI before any driver or vendor
// tool is installed.
type Card struct {
	Address string // 0000:0c:00.0, as the console names cards
	Vendor  string // intel, nvidia, amd
	Name    string // lspci's description
}

// Machine is what the setup screen says it found.
type Machine struct {
	OS     string
	RAMGiB int
	Cards  []Card
	// XPUSMI: Intel's telemetry tool is on the PATH. The console sees Intel
	// cards only through it.
	XPUSMI bool
}

// Vendors are the distinct vendors among the cards, in the order found.
func (m Machine) Vendors() []string {
	var out []string
	seen := map[string]bool{}
	for _, c := range m.Cards {
		if !seen[c.Vendor] {
			seen[c.Vendor] = true
			out = append(out, c.Vendor)
		}
	}
	return out
}

// `0000:0c:00.0 VGA compatible controller [0300]: Intel Corporation Device [8086:e223]`
var pciLine = regexp.MustCompile(`^(\S+) [^\[]*\[(03[0-9a-f]{2})\]: (.*) \[([0-9a-f]{4}):([0-9a-f]{4})\]`)

var pciVendors = map[string]string{"8086": "intel", "10de": "nvidia", "1002": "amd", "1022": "amd"}

// ParseLspci reads `lspci -D -nn` output: display controllers of a vendor
// the console knows, others (a BMC's graphics, say) left out.
func ParseLspci(text string) []Card {
	var out []Card
	for _, line := range strings.Split(text, "\n") {
		m := pciLine.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil {
			continue
		}
		vendor, ok := pciVendors[m[4]]
		if !ok {
			continue
		}
		name := strings.TrimSpace(m[3])
		// lspci names new cards "Device" with no model; the id is at least
		// something to tell two apart.
		if strings.HasSuffix(name, " Device") {
			name += " " + m[5]
		}
		out = append(out, Card{Address: m[1], Vendor: vendor, Name: name})
	}
	return out
}

// Detect reads the machine without changing anything.
func Detect(ctx context.Context) Machine {
	var m Machine
	if f, err := os.Open("/etc/os-release"); err == nil {
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			if v, ok := strings.CutPrefix(sc.Text(), "PRETTY_NAME="); ok {
				m.OS = strings.Trim(v, `"`)
			}
		}
		f.Close()
	}
	if raw, err := os.ReadFile("/proc/meminfo"); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			if v, ok := strings.CutPrefix(line, "MemTotal:"); ok {
				kb, _ := strconv.Atoi(strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(v), "kB")))
				m.RAMGiB = int((int64(kb)*1024 + 1<<29) >> 30)
			}
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "lspci", "-D", "-nn").Output(); err == nil {
		m.Cards = ParseLspci(string(out))
	}
	_, err := exec.LookPath("xpu-smi")
	m.XPUSMI = err == nil
	return m
}
