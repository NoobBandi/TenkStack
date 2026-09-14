package containers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
	"github.com/NoobBandi/TenkStack/server-go/internal/vendors"
)

// BusKey folds a PCI address into the form two sources agree on: the
// kernel writes four domain digits and lower case, nvidia-smi eight and
// upper. The domain is dropped and the rest folded down.
func BusKey(address string) string {
	parts := strings.Split(strings.ToLower(strings.TrimSpace(address)), ":")
	if len(parts) < 2 {
		return strings.ToLower(strings.TrimSpace(address))
	}
	return strings.Join(parts[len(parts)-2:], ":")
}

// Inspect maps container name to its docker inspect record.
func (d *Docker) Inspect(ctx context.Context, names []string) map[string]map[string]any {
	out := map[string]map[string]any{}
	if len(names) == 0 {
		return out
	}
	raw, ok := d.run(ctx, append([]string{"inspect"}, names...)...)
	if !ok {
		return out
	}
	var entries []map[string]any
	if err := json.Unmarshal([]byte(raw), &entries); err != nil {
		log.Print("could not parse docker inspect output")
		return out
	}
	for _, e := range entries {
		if name, _ := e["Name"].(string); name != "" {
			out[strings.TrimPrefix(name, "/")] = e
		}
	}
	return out
}

// ImageOf is the image id a container was created from, or the name when
// it cannot be asked.
func (d *Docker) ImageOf(ctx context.Context, name string) string {
	if e := d.Inspect(ctx, []string{name})[name]; e != nil {
		if image, _ := e["Image"].(string); image != "" {
			return image
		}
	}
	return name
}

// claimedCards asks every vendor which cards a container's HostConfig got.
// Deduplicated, because Intel and AMD both recognise the same render node.
func claimedCards(host map[string]any, cards []vendors.Card) ([]string, bool) {
	wants := false
	seen := map[string]bool{}
	var out []string
	for _, v := range vendors.All() {
		found, asked := v.Claims(host, cards)
		for _, address := range found {
			if !seen[address] {
				seen[address] = true
				out = append(out, address)
			}
		}
		wants = wants || asked
	}
	return out, wants
}

// portsOf renders `127.0.0.1:8189->8188/tcp` from HostConfig rather than
// docker ps, whose column is empty for a stopped container.
func portsOf(host map[string]any) string {
	bindings, _ := host["PortBindings"].(map[string]any)
	targets := make([]string, 0, len(bindings))
	for t := range bindings {
		targets = append(targets, t)
	}
	sort.Strings(targets)
	var published []string
	for _, target := range targets {
		list, _ := bindings[target].([]any)
		for _, item := range list {
			b, _ := item.(map[string]any)
			address, _ := b["HostIp"].(string)
			if address == "" {
				address = "0.0.0.0"
			}
			port := fmt.Sprint(b["HostPort"])
			if b["HostPort"] == nil {
				port = "None"
			}
			published = append(published, address+":"+port+"->"+target)
		}
	}
	return strings.Join(published, ", ")
}

func optStr(m map[string]any, key string) *string {
	if s, ok := m[key].(string); ok {
		return &s
	}
	return nil
}

// Survey pairs every container on this machine with the cards it holds.
// Cards are passed in rather than probed again.
func (d *Docker) Survey(ctx context.Context, cards []vendors.Card) api.Survey {
	listing, ok := d.run(ctx, "ps", "-a", "--format", "{{json .}}")
	if !ok {
		return api.Survey{Available: false, Containers: []api.SurveyContainer{}, IdleGPUs: []api.CardRef{}}
	}
	var rows []map[string]any
	for _, line := range strings.Split(listing, "\n") {
		var row map[string]any
		if json.Unmarshal([]byte(line), &row) == nil && row != nil {
			rows = append(rows, row)
		}
	}
	var names []string
	for _, row := range rows {
		if name, _ := row["Names"].(string); name != "" {
			names = append(names, name)
		}
	}
	details := d.Inspect(ctx, names)
	byBus := map[string]vendors.Card{}
	for _, c := range cards {
		if c.PCIBDFAddress != "" {
			byBus[BusKey(c.PCIBDFAddress)] = c
		}
	}

	held := map[string]bool{}
	out := []api.SurveyContainer{}
	for _, row := range rows {
		name, _ := row["Names"].(string)
		host, _ := details[name]["HostConfig"].(map[string]any)
		if host == nil {
			host = map[string]any{}
		}
		claimed, wants := claimedCards(host, cards)
		refs := []api.CardRef{}
		for _, address := range claimed {
			if card, ok := byBus[BusKey(address)]; ok {
				held[BusKey(address)] = true
				refs = append(refs, api.CardRef{PCIBDFAddress: card.PCIBDFAddress, Name: card.Name, Vendor: card.Vendor})
			}
		}
		policy := "no"
		if rp, _ := host["RestartPolicy"].(map[string]any); rp != nil {
			if n, _ := rp["Name"].(string); n != "" {
				policy = n
			}
		}
		out = append(out, api.SurveyContainer{
			Name: name, Image: optStr(row, "Image"), State: optStr(row, "State"), Status: optStr(row, "Status"),
			Ports: portsOf(host), Created: optStr(row, "CreatedAt"), RestartPolicy: policy,
			WantsGPU: wants, Cards: refs, Orphaned: wants && len(refs) == 0,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })

	idle := []api.CardRef{}
	for _, c := range cards {
		if c.PCIBDFAddress != "" && !held[BusKey(c.PCIBDFAddress)] {
			idle = append(idle, api.CardRef{PCIBDFAddress: c.PCIBDFAddress, Name: c.Name, Vendor: c.Vendor})
		}
	}
	return api.Survey{Available: true, Containers: out, IdleGPUs: idle}
}

// `127.0.0.1:8188->8188/tcp`: the host port is the number before the arrow.
var published = regexp.MustCompile(`:(\d+)->`)

// PortCards maps a published host port to the PCI addresses that container
// holds: the only exact join between a ComfyUI instance and its card.
func (d *Docker) PortCards(ctx context.Context, cards []vendors.Card) map[int][]string {
	out := map[int][]string{}
	for _, c := range d.Survey(ctx, cards).Containers {
		var addresses []string
		for _, card := range c.Cards {
			addresses = append(addresses, card.PCIBDFAddress)
		}
		if len(addresses) == 0 {
			continue
		}
		for _, m := range published.FindAllStringSubmatch(c.Ports, -1) {
			port, _ := strconv.Atoi(m[1])
			out[port] = addresses
		}
	}
	return out
}

// Held is one container bound to a card, for the per-card view.
type Held struct {
	Name  string  `json:"name"`
	State *string `json:"state"`
	Image *string `json:"image"`
	Ports string  `json:"ports"`
}

// ByCard maps a PCI bus key to the containers holding that card.
func (d *Docker) ByCard(ctx context.Context, cards []vendors.Card) map[string][]Held {
	out := map[string][]Held{}
	for _, c := range d.Survey(ctx, cards).Containers {
		for _, card := range c.Cards {
			key := BusKey(card.PCIBDFAddress)
			out[key] = append(out[key], Held{Name: c.Name, State: c.State, Image: c.Image, Ports: c.Ports})
		}
	}
	return out
}
