package setup

import (
	"fmt"
	"sort"
	"strings"

	"github.com/NoobBandi/TenkStack/internal/providers"
)

// Answers are the setup's result, in the terms install.sh already uses
// for its flags: whatever the screen asks, a flag can say too.
type Answers struct {
	Lang Lang
	// Action is "install" or "uninstall".
	Action string
	Root   string
	// Engines are registry keys: llamacpp, vllm.
	Engines []string
	// Comfy are PCI addresses of the cards to run ComfyUI on.
	Comfy   []string
	SearXNG bool
	// TLS is "" (plain HTTP), "internal" or "domain".
	TLS    string
	Domain string
	// Uninstall only: delete the install directory too (models included),
	// and leave the container images.
	Purge      bool
	KeepImages bool
}

// quote makes a value safe inside a shell assignment.
func quote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// Shell renders the answers as assignments install.sh sources.
func (a Answers) Shell() string {
	yn := "n"
	if a.SearXNG {
		yn = "y"
	}
	action := a.Action
	if action == "" {
		action = "install"
	}
	lines := []string{
		"UI_LANG=" + quote(string(a.Lang)),
		"ACTION=" + quote(action),
		"ROOT=" + quote(a.Root),
		"ENGINES=" + quote(strings.Join(a.Engines, ",")),
		"COMFY_CARDS=" + quote(strings.Join(a.Comfy, ",")),
		"WANT_SEARXNG=" + quote(yn),
		"TLS_MODE=" + quote(a.TLS),
		"DOMAIN=" + quote(a.Domain),
		// install.sh runs these as commands, so they are true or false.
		"PURGE=" + quote(fmt.Sprint(a.Purge)),
		"KEEP_IMAGES=" + quote(fmt.Sprint(a.KeepImages)),
	}
	return strings.Join(lines, "\n") + "\n"
}

// Engine is one engine the setup can offer on this machine.
type Engine struct {
	Key      string
	Name     string
	Default  bool
	Vendors  []string // the machine's vendors it has a build for
	Verified bool     // every one of those builds is verified
}

// EnginesFor lists the registry's engines that have a build for at least
// one of the vendors, the default engine first.
func EnginesFor(vendors []string) []Engine {
	var out []Engine
	for _, p := range providers.All() {
		if p.Category != "llm" {
			continue
		}
		e := Engine{Key: p.Key, Name: p.Name, Default: p.Default, Verified: true}
		for _, v := range vendors {
			b, ok := p.Builds[v]
			if !ok {
				continue
			}
			e.Vendors = append(e.Vendors, v)
			if !b.Verified {
				e.Verified = false
			}
		}
		if len(e.Vendors) > 0 {
			out = append(out, e)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Default && !out[j].Default })
	return out
}
