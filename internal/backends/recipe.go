package backends

import (
	"context"
	"fmt"
	"log"
	"os"
	"regexp"
	"strings"

	"github.com/NoobBandi/TenkStack/internal/api"
	"github.com/NoobBandi/TenkStack/internal/providers"
)

// How an installed launcher stands against the engine's record today.
const (
	RecipeCurrent  = "current"  // what the record writes now
	RecipeOutdated = "outdated" // the console wrote it, from an older record
	RecipeEdited   = "edited"   // changed by hand; left alone
)

// The multi-card start line changes with the image a build uses (the b2
// image sourced oneAPI; upstream's has none).
var runLine = regexp.MustCompile(`(?m)^\s*RUN=\(--entrypoint bash .*\)$`)

// skeleton is a launcher with what a newer record may change blanked
// out: comments (the notes come from the record), the image tag, and a
// start command the build used before, read as today's. Two launchers
// with the same skeleton differ in nothing a person wrote.
func skeleton(p providers.Provider, vendor, text string) string {
	text = imageLine.ReplaceAllString(text, "IMAGE")
	if b, ok := p.Builds[vendor]; ok && b.MultiCard != nil {
		m := b.MultiCard
		text = runLine.ReplaceAllStringFunc(text, func(line string) string {
			for _, old := range m.Formerly {
				line = strings.Replace(line, old, m.Entrypoint, 1)
			}
			return line
		})
	}
	var keep []string
	for _, line := range strings.Split(text, "\n") {
		if t := strings.TrimSpace(line); t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		keep = append(keep, line)
	}
	return strings.Join(keep, "\n")
}

// Recipe reads an installed launcher: whether it is what the record
// writes now, an older version of it, or a hand edit; the variant it was
// written for; and the image the record recommends for that variant.
func (in *Installer) Recipe(p providers.Provider, vendor string) (state, variant, recommended string) {
	raw, err := os.ReadFile(in.script(p, vendor))
	if err != nil {
		return "", "", ""
	}
	text := string(raw)
	// "" is the vendor's own build, with its multi-card block.
	variants := []string{""}
	if p.Fallback != nil {
		variants = append(variants, "vulkan")
	}
	for _, v := range variants {
		want := WrapperText(p, vendor, in.ModelsDir, v)
		if want == "" {
			continue
		}
		spec := specFor(p, vendor, v)
		switch {
		case text == want:
			return RecipeCurrent, v, spec.Image
		case skeleton(p, vendor, text) == skeleton(p, vendor, want):
			return RecipeOutdated, v, spec.Image
		}
	}
	return RecipeEdited, "", ""
}

// Upgrade brings an outdated launcher to what the record writes now: pull
// the recommended image, then rewrite the launcher. Models already loaded
// keep running on the old image until they are next started. A launcher
// edited by hand is refused -- it is somebody's, and a rewrite would
// throw their change away.
func (in *Installer) Upgrade(ctx context.Context, key, vendor string) (api.Install, error) {
	p, err := providers.Lookup(key)
	if err != nil {
		return api.Install{}, &Invalid{err.Error()}
	}
	state, variant, image := in.Recipe(p, vendor)
	switch state {
	case "":
		return api.Install{}, &Invalid{fmt.Sprintf("%s 在 %s 上還沒安裝", p.Name, vendor)}
	case RecipeEdited:
		return api.Install{}, &Invalid{"啟動腳本改過，不會自動改寫；要換版本請手動修改 " + p.ScriptName(vendor)}
	case RecipeCurrent:
		return api.Install{}, &Invalid{"已經是建議的版本"}
	}
	if running := in.busy(p, vendor); running != nil {
		return *running, nil
	}
	rec := &api.Install{Provider: p.Key, Vendor: vendor, Image: image, State: "pulling"}
	in.Probe.mu.Lock()
	in.Probe.installs[slot(p, vendor)] = rec
	in.Probe.mu.Unlock()
	path := in.script(p, vendor)
	go func() {
		bg := context.Background()
		if !in.Images.Pull(bg, image, installProgress{in.Probe, rec}) {
			return
		}
		in.Probe.mu.Lock()
		rec.State = "writing"
		in.Probe.mu.Unlock()
		mode := os.FileMode(0o755)
		if st, err := os.Stat(path); err == nil {
			mode = st.Mode().Perm()
		}
		tmp := path + ".tmp"
		err := os.WriteFile(tmp, []byte(WrapperText(p, vendor, in.ModelsDir, variant)), mode)
		if err == nil {
			err = os.Rename(tmp, path)
		}
		if err == nil && variant != "vulkan" {
			err = in.writeSetup(p, vendor)
		}
		in.Probe.mu.Lock()
		if err != nil {
			rec.State, rec.Message = "error", err.Error()
			in.Probe.mu.Unlock()
			log.Printf("could not upgrade %s for %s: %v", p.Name, vendor, err)
			return
		}
		in.Probe.mu.Unlock()
		in.Probe.Usable(bg, true)
		in.Probe.mu.Lock()
		rec.State, rec.Message = "done", path
		in.Probe.mu.Unlock()
		log.Printf("upgraded %s for %s to %s", p.Name, vendor, image)
	}()
	return *rec, nil
}
