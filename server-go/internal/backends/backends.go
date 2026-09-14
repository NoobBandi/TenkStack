// Package backends answers which cards a configured llama-server can
// actually run a model on, by asking each launcher for --list-devices. Not
// which cards exist: the SYCL build sees the Arc and not the RTX beside it.
package backends

import (
	"context"
	"log"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
	"github.com/NoobBandi/TenkStack/server-go/internal/vendors"
)

// `  SYCL0: Intel(R) Arc(TM) Pro B70 Graphics (32656 MiB, 32092 MiB free)`
var deviceLine = regexp.MustCompile(`^\s*([A-Za-z]+)(\d+):\s*(.*?)\s*\((\d+)\s*MiB`)

// The SYCL wrapper pins one card by default, right for running and wrong
// for enumerating; it defaults the variable, so this overrides it.
var probeEnv = "ONEAPI_DEVICE_SELECTOR=level_zero:*"

// Sourcing oneAPI's setvars.sh is most of this, and it is not fast.
const probeTimeout = 90 * time.Second

// Launchers is what the probe needs from the config.
type Launchers interface {
	Launchers() []string
}

type Probe struct {
	launchers Launchers

	mu    sync.Mutex
	cache []api.BackendDevice
}

func New(launchers Launchers) *Probe { return &Probe{launchers: launchers} }

func ask(ctx context.Context, launcher string) []api.BackendDevice {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, launcher, "--list-devices")
	cmd.Env = append(os.Environ(), probeEnv)
	out, err := cmd.CombinedOutput()
	if err != nil && len(out) == 0 {
		log.Printf("could not run %s: %v", launcher, err)
		return nil
	}
	selectors := vendors.BackendSelectors()
	var devices []api.BackendDevice
	for _, line := range strings.Split(string(out), "\n") {
		m := deviceLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		index, _ := strconv.Atoi(m[2])
		total, _ := strconv.Atoi(m[4])
		env := map[string]string{}
		if sel, ok := selectors[strings.ToUpper(m[1])]; ok && sel.Variable != "" {
			env[sel.Variable] = strings.ReplaceAll(sel.Template, "{}", m[2])
		}
		devices = append(devices, api.BackendDevice{
			Backend: m[1], Index: index, Name: m[3], TotalMiB: total, Launcher: launcher, Env: env,
		})
	}
	return devices
}

// Usable is every card a configured llama-server can see, across all
// launchers. Cached: the answer changes when a build or a card changes, not
// between requests, and each probe costs a oneAPI environment setup.
func (p *Probe) Usable(ctx context.Context, refresh bool) []api.BackendDevice {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cache != nil && !refresh {
		return p.cache
	}
	found := []api.BackendDevice{}
	for _, launcher := range p.launchers.Launchers() {
		for _, d := range ask(ctx, launcher) {
			dup := false
			for _, f := range found {
				if f.Backend == d.Backend && f.Index == d.Index {
					dup = true
				}
			}
			if !dup {
				found = append(found, d)
			}
		}
	}
	p.cache = found
	names := make([]string, len(found))
	for i, d := range found {
		names[i] = d.Backend + strconv.Itoa(d.Index) + " " + d.Name
	}
	log.Printf("llama-server sees %d device(s): %s", len(found), strings.Join(names, ", "))
	return found
}

// Match attaches each usable device to the console's own card entry by
// name, which is all --list-devices gives. Two identical cards are left
// with the second unmatched rather than both on the first: a wrong card is
// worse than none, because the VRAM policy would then measure the wrong one.
func Match(devices []api.BackendDevice, cards []api.GpuDevice) []api.BackendDevice {
	taken := map[string]bool{}
	out := make([]api.BackendDevice, 0, len(devices))
	for _, d := range devices {
		d.PCIBDFAddress = nil
		for _, c := range cards {
			if c.PCIBDFAddress == nil || *c.PCIBDFAddress == "" || taken[*c.PCIBDFAddress] {
				continue
			}
			name := ""
			if c.Name != nil {
				name = strings.TrimSpace(*c.Name)
			}
			if name == strings.TrimSpace(d.Name) {
				addr := *c.PCIBDFAddress
				d.PCIBDFAddress = &addr
				taken[addr] = true
				break
			}
		}
		out = append(out, d)
	}
	return out
}
