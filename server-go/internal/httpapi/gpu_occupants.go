package httpapi

import (
	"net/http"
	"strings"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
	"github.com/NoobBandi/TenkStack/server-go/internal/backends"
	"github.com/NoobBandi/TenkStack/server-go/internal/containers"
	"github.com/NoobBandi/TenkStack/server-go/internal/providers"
	"github.com/NoobBandi/TenkStack/server-go/internal/vendors"
)

// selects says whether an entry's selector value (level_zero:0,1) names
// the one card a probed device's value (level_zero:1) names.
func selects(entry, device string, templates []string) bool {
	if entry == "" || device == "" {
		return false
	}
	if entry == device {
		return true
	}
	for _, tpl := range templates {
		prefix, suffix, ok := strings.Cut(tpl, "{}")
		if !ok || !strings.HasPrefix(device, prefix) || !strings.HasSuffix(device, suffix) {
			continue
		}
		index := strings.TrimSuffix(strings.TrimPrefix(device, prefix), suffix)
		list := strings.TrimSuffix(strings.TrimPrefix(entry, prefix), suffix)
		for _, item := range strings.Split(list, ",") {
			if strings.TrimSpace(item) == index {
				return true
			}
		}
	}
	return false
}

// readGpuOccupants is what holds each card now, keyed by PCI address: the
// loaded models, by the cards their entry selects, and the containers
// that were handed a card. The answer to a card that looks full.
func (s *Server) readGpuOccupants(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	found := s.Gpu.Discover(ctx)
	devices := make([]api.GpuDevice, 0, len(found))
	cards := make([]vendors.Card, 0, len(found))
	for _, d := range found {
		devices = append(devices, api.GpuDevice{Index: d.Index, Name: d.Name, PCIBDFAddress: d.PCIBDFAddress, Vendor: d.Vendor})
		cards = append(cards, vendors.Card{PCIBDFAddress: deref(d.PCIBDFAddress), Name: d.Name, Vendor: d.Vendor})
	}
	usable := backends.Match(s.Backends.Usable(ctx, false), devices)
	templates := map[string][]string{}
	for _, sel := range vendors.BackendSelectors() {
		templates[sel.Variable] = append(templates[sel.Variable], sel.Template)
	}

	out := map[string][]api.GpuOccupant{}
	for _, c := range cards {
		if c.PCIBDFAddress != "" {
			out[c.PCIBDFAddress] = []api.GpuOccupant{}
		}
	}
	var running []string
	for _, entry := range s.LlamaSwap.Running(ctx) {
		id, _ := entry["model"].(string)
		state, _ := entry["state"].(string)
		if id == "" {
			continue
		}
		running = append(running, id)
		spec := s.Models.ReadSpec(id)
		env := map[string]string{}
		occupant := api.GpuOccupant{Kind: "model", Name: id, State: state}
		key := providers.DefaultProvider().Key
		if spec != nil {
			env = spec.Env
			if spec.Name != "" {
				occupant.Name = spec.Name
			}
			if spec.Provider != "" {
				key = spec.Provider
			}
		}
		if p := providers.Get(key); p != nil {
			occupant.Engine = p.Name
		}
		var held []string
		for _, d := range usable {
			if d.PCIBDFAddress == nil {
				continue
			}
			for variable, value := range d.Env {
				if selects(env[variable], value, templates[variable]) {
					held = append(held, *d.PCIBDFAddress)
					break
				}
			}
		}
		// No selector: the engine sees every card it can, and llama.cpp
		// splits across all of them.
		if len(held) == 0 {
			for _, d := range usable {
				if d.PCIBDFAddress != nil {
					held = append(held, *d.PCIBDFAddress)
				}
			}
		}
		occupant.Cards = len(held)
		for _, address := range held {
			out[address] = append(out[address], occupant)
		}
	}
	byCard := s.Docker.ByCard(ctx, cards)
	spans := map[string]int{}
	for _, boxes := range byCard {
		for _, box := range boxes {
			spans[box.Name]++
		}
	}
	for bus, boxes := range byCard {
		address := ""
		for _, c := range cards {
			if containers.BusKey(c.PCIBDFAddress) == bus {
				address = c.PCIBDFAddress
			}
		}
		if address == "" {
			continue
		}
		for _, box := range boxes {
			// A model's own container is already there as the model.
			mine := false
			for _, id := range running {
				if strings.Contains(box.Name, id) {
					mine = true
				}
			}
			if mine {
				continue
			}
			occupant := api.GpuOccupant{Kind: "container", Name: box.Name, Cards: spans[box.Name]}
			if box.State != nil {
				occupant.State = *box.State
			}
			out[address] = append(out[address], occupant)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
