package httpapi

import (
	gocontext "context"
	"net/http"

	"sort"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
	"github.com/NoobBandi/TenkStack/server-go/internal/backends"
	"github.com/NoobBandi/TenkStack/server-go/internal/providers"
	"github.com/NoobBandi/TenkStack/server-go/internal/vendors"
)

// readProviders is the store's inventory and the model form's choice: every
// provider with a build per vendor that has a card here, and every launcher
// the config currently names.
func (s *Server) readProviders(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	present := map[string]bool{}
	for _, c := range s.cards(ctx) {
		present[c.Vendor] = true
	}
	page := api.ProvidersPage{Providers: []api.ProviderCard{}, Runtimes: []api.Runtime{}}
	launchers := s.Config.LauncherList()
	for _, p := range providers.All() {
		card := api.ProviderCard{
			Key: p.Key, Name: p.Name, Summary: p.Summary, Category: p.Category,
			Formats: p.Formats, Site: p.Site, Builds: []api.ProviderBuild{},
			Default: p.Default, Form: p.Form, Icon: "/api/providers/" + p.Key + "/icon",
			Recommended: []api.Recommendation{}, Launchers: []string{}, InUse: []string{},
		}
		for _, rec := range p.Recommended {
			card.Recommended = append(card.Recommended, api.Recommendation{Match: rec.Match, Flags: rec.Flags, Note: rec.Note, Vendors: rec.Vendors})
		}
		inUse := map[string]bool{}
		for _, l := range launchers {
			owner, _, managed := providers.Resolve(l.Name)
			// A launcher registered by hand is a llama.cpp build: that is
			// what every launcher was before there was a choice.
			if !managed {
				owner = *providers.Get(providers.LlamaCpp)
			}
			if owner.Key != p.Key {
				continue
			}
			if !managed {
				card.Launchers = append(card.Launchers, l.Name)
			}
			for _, id := range s.Config.ModelsUsing("${" + l.Name + "}") {
				inUse[id] = true
			}
		}
		for id := range inUse {
			card.InUse = append(card.InUse, id)
		}
		sort.Strings(card.InUse)
		templates := backends.Templates(p)
		for _, v := range vendors.All() {
			t, ok := templates[v.Key]
			if !ok || !present[v.Key] {
				continue
			}
			card.Builds = append(card.Builds, api.ProviderBuild{
				Vendor: v.Key, VendorLabel: v.Label, Macro: p.Macro(v.Key),
				Image: t.Image, Requires: t.Requires, Verified: t.Verified,
				State: s.Installer.State(ctx, p.Key, v.Key),
			})
		}
		page.Providers = append(page.Providers, card)
	}
	for _, l := range s.Config.LauncherList() {
		rt := api.Runtime{Macro: l.Name, Quantizations: []api.Quantization{}}
		if p, vendor, ok := providers.Resolve(l.Name); ok {
			label := p.Name
			if v := vendors.Get(vendor); v != nil {
				label += "・" + v.Label
			}
			rt.Label, rt.Provider, rt.Vendor, rt.Formats, rt.Managed = label, p.Key, vendor, p.Formats, true
			rt.Form = p.Form
			rt.Quantizations = s.onlineQuantizations(ctx, p, vendor)
		} else {
			// A launcher registered by hand is a llama.cpp build: that is
			// what every launcher was before there was a choice.
			p := providers.Get(providers.LlamaCpp)
			rt.Label, rt.Provider, rt.Formats = p.Name+"・"+l.Name, p.Key, p.Formats
			rt.Form = p.Form
		}
		page.Runtimes = append(page.Runtimes, rt)
	}
	writeJSON(w, http.StatusOK, page)
}

// onlineQuantizations is what a provider's record offers for bf16 weights,
// kept to what its image says it has. An image that cannot be asked keeps
// the record's list: better an option that fails at load than none.
func (s *Server) onlineQuantizations(ctx gocontext.Context, p providers.Provider, vendor string) []api.Quantization {
	out := []api.Quantization{}
	if len(p.Online) == 0 {
		return out
	}
	has := map[string]bool{}
	if img := s.Installer.State(ctx, p.Key, vendor).Image; img != nil {
		for _, m := range s.Flags.Quantizations(ctx, *img, s.Docker.ImageID(ctx, *img)) {
			has[m] = true
		}
	}
	for _, q := range p.Online {
		if len(has) == 0 || has[q.Value] {
			out = append(out, api.Quantization{Value: q.Value, Label: q.Label, Note: q.Note, Shrink: q.Shrink})
		}
	}
	return out
}

// formOf is the form of a provider by key; an entry named by hand, which
// has no provider, is llama.cpp's.
func formOf(key string) string {
	if p := providers.Get(key); p != nil {
		return p.Form
	}
	return providers.FormLlama
}

// providerIcon is an engine's icon from its registry record. Icons change
// only with the console, so a day's caching is safe.
func (s *Server) providerIcon(w http.ResponseWriter, r *http.Request) {
	p := providers.Get(r.PathValue("key"))
	if p == nil {
		fail(w, http.StatusNotFound, "no such engine")
		return
	}
	data, mime := p.IconData()
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "private, max-age=86400")
	// An SVG is a document; opened on its own it must not run anything.
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
	w.Write(data)
}
