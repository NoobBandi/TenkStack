// Package gpu answers the same four questions of every vendor: what cards
// are here, what are they doing, what are their limits, and what else is
// worth showing. One Provider per vendor; everything above works in watts
// and mebibytes and never learns which vendor it is talking to.
package gpu

import (
	"context"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"

	"github.com/NoobBandi/TenkStack/internal/api"
)

// Above this fraction of its own maximum clock a card is doing work. Power
// cannot answer that: a resident model draws power while computing nothing.
const BusyClockFraction = 0.35

// Device is one card as a provider lists it, before global renumbering.
type Device struct {
	Index         int
	Name          *string
	DRMDevice     *string
	PCIBDFAddress *string
	State         *string
	Raw           map[string]any
	Vendor        string
}

type Provider interface {
	Key() string
	Label() string
	// Discover lists the cards present; empty means this vendor is not here.
	// A provider whose tool is missing returns empty, not an error.
	Discover(ctx context.Context) ([]Device, error)
	Sample(ctx context.Context, index int) (*api.GpuSample, error)
	Detail(ctx context.Context, index int) (*api.GpuDetail, error)
}

// Busy fills the derived field on a sample.
func Busy(s *api.GpuSample) bool {
	if s.FrequencyMHz == nil || s.FrequencyMaxMHz == nil || *s.FrequencyMaxMHz == 0 {
		return false
	}
	return *s.FrequencyMHz > *s.FrequencyMaxMHz*BusyClockFraction
}

type route struct {
	provider Provider
	local    int
}

// Registry probes every candidate vendor once and renumbers the cards of all
// that answered into one index space, in candidate order. Indices are stable
// because that order is stable and cards are not hot-plugged.
type Registry struct {
	candidates []Provider

	mu     sync.Mutex
	live   []Provider
	routes []route
}

func NewRegistry(candidates ...Provider) *Registry {
	return &Registry{candidates: candidates}
}

// Providers are the vendors with hardware present. Re-probed while nothing
// has been found so a driver that loads late is picked up; once anything
// answers, the answer sticks.
func (r *Registry) Providers(ctx context.Context) []Provider {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.live) > 0 {
		return r.live
	}
	var found []Provider
	for _, p := range r.candidates {
		devices, err := p.Discover(ctx)
		if err != nil {
			log.Printf("%s provider failed while probing: %v", p.Key(), err)
			continue
		}
		if len(devices) > 0 {
			found = append(found, p)
		}
	}
	if len(found) > 0 {
		r.live = found
		labels := make([]string, len(found))
		for i, p := range found {
			labels[i] = p.Label()
		}
		log.Printf("GPU providers: %s", strings.Join(labels, ", "))
	}
	return found
}

func (r *Registry) ActiveKeys() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	keys := make([]string, 0, len(r.live))
	for _, p := range r.live {
		keys = append(keys, p.Key())
	}
	return keys
}

// Discover lists every card, renumbered, and rebuilds the routing table.
func (r *Registry) Discover(ctx context.Context) []Device {
	var routes []route
	var out []Device
	for _, p := range r.Providers(ctx) {
		devices, err := p.Discover(ctx)
		if err != nil {
			log.Printf("%s provider failed while listing devices: %v", p.Key(), err)
			continue
		}
		for _, d := range devices {
			routes = append(routes, route{p, d.Index})
			d.Index = len(out)
			d.Vendor = p.Key()
			out = append(out, d)
		}
	}
	if len(routes) > 0 {
		r.mu.Lock()
		r.routes = routes
		r.mu.Unlock()
	}
	return out
}

// Indices are the global indices of every card found.
func (r *Registry) Indices(ctx context.Context) []int {
	devices := r.Discover(ctx)
	out := make([]int, 0, len(devices))
	for _, d := range devices {
		out = append(out, d.Index)
	}
	sort.Ints(out)
	return out
}

func (r *Registry) route(ctx context.Context, index int) (route, bool) {
	r.mu.Lock()
	empty := len(r.routes) == 0
	r.mu.Unlock()
	if empty {
		r.Discover(ctx)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if index < 0 || index >= len(r.routes) {
		return route{}, false
	}
	return r.routes[index], true
}

// Sample reads one card's live counters, or nil.
func (r *Registry) Sample(ctx context.Context, index int) *api.GpuSample {
	rt, ok := r.route(ctx, index)
	if !ok {
		return nil
	}
	s, err := rt.provider.Sample(ctx, rt.local)
	if err != nil {
		log.Printf("%s provider failed while sampling device %d: %v", rt.provider.Key(), rt.local, err)
		return nil
	}
	if s == nil {
		return nil
	}
	s.Index = index
	s.Vendor = rt.provider.Key()
	s.Busy = Busy(s)
	return s
}

func (r *Registry) Detail(ctx context.Context, index int) *api.GpuDetail {
	rt, ok := r.route(ctx, index)
	if !ok {
		return nil
	}
	d, err := rt.provider.Detail(ctx, rt.local)
	if err != nil {
		log.Printf("%s provider failed while describing device %d: %v", rt.provider.Key(), rt.local, err)
		return nil
	}
	return d
}

// ListDevices is every card with its inventory and live counters attached.
func (r *Registry) ListDevices(ctx context.Context) []api.GpuDevice {
	devices := r.Discover(ctx)
	out := make([]api.GpuDevice, 0, len(devices))
	for _, d := range devices {
		var (
			detail *api.GpuDetail
			live   *api.GpuSample
			wg     sync.WaitGroup
		)
		wg.Add(2)
		go func() { defer wg.Done(); detail = r.Detail(ctx, d.Index) }()
		go func() { defer wg.Done(); live = r.Sample(ctx, d.Index) }()
		wg.Wait()
		groups := []api.DetailGroup{}
		if detail != nil && detail.Groups != nil {
			groups = detail.Groups
		}
		out = append(out, api.GpuDevice{
			Index:         d.Index,
			Name:          d.Name,
			DRMDevice:     d.DRMDevice,
			PCIBDFAddress: d.PCIBDFAddress,
			State:         d.State,
			Vendor:        d.Vendor,
			Groups:        groups,
			Live:          live,
			PCIe:          PCIeLink("/sys", deref(d.PCIBDFAddress)),
		})
	}
	return out
}

// FallbackName is what a card is called when the vendor gives no name.
func FallbackName(prefix string, index int) string {
	return fmt.Sprintf("%s:%d", prefix, index)
}
