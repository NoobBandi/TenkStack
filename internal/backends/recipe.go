package backends

import (
	"context"
	"fmt"
	"log"
	"os"
	"regexp"
	"strings"
	"time"

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

// launcherImage is the image a launcher's text names, or "".
func launcherImage(text string) string {
	if m := imageLine.FindStringSubmatch(text); m != nil {
		return m[1]
	}
	return ""
}

// withImage is a launcher's text naming another image. Every build writes
// the same launcher for each of its images; only this line differs.
func withImage(text, image string) string {
	return imageLine.ReplaceAllStringFunc(text, func(line string) string {
		m := imageLine.FindStringSubmatchIndex(line)
		return line[:m[2]] + image + line[m[3]:]
	})
}

// offers is whether a variant of the provider's build for vendor runs
// image: any of the build's choices, or the fallback's one image.
func offers(p providers.Provider, vendor, variant, image string) bool {
	if variant == "vulkan" {
		return p.Fallback != nil && p.Fallback.Image == image
	}
	b, ok := p.Builds[vendor]
	return ok && b.Offers(image)
}

// Recipe reads an installed launcher: whether it is what the record
// writes now, an older version of it, or a hand edit; the variant it was
// written for; and the image bringing it up to date would leave it on --
// the image it already runs when that is still one of the build's choices,
// so an update never swaps a picked nightly for the release, and the
// record's own image when it is not.
func (in *Installer) Recipe(p providers.Provider, vendor string) (state, variant, recommended string) {
	raw, err := os.ReadFile(in.script(p, vendor))
	if err != nil {
		return "", "", ""
	}
	text := string(raw)
	have := launcherImage(text)
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
		target := specFor(p, vendor, v).Image
		if offers(p, vendor, v, have) {
			want, target = withImage(want, have), have
		}
		switch {
		case text == want:
			return RecipeCurrent, v, target
		case skeleton(p, vendor, text) == skeleton(p, vendor, want):
			return RecipeOutdated, v, target
		}
	}
	return RecipeEdited, "", ""
}

// Upgrade brings a launcher to what the record writes now, on image when
// one is named -- which is how one of a build's images is swapped for
// another -- and otherwise on the image Recipe recommends: pull it, then
// rewrite the launcher. Models already loaded keep running on the old
// image until they are next started. A launcher edited by hand is refused
// -- it is somebody's, and a rewrite would throw their change away.
func (in *Installer) Upgrade(ctx context.Context, key, vendor, image string) (api.Install, error) {
	p, err := providers.Lookup(key)
	if err != nil {
		return api.Install{}, &Invalid{err.Error()}
	}
	state, variant, recommended := in.Recipe(p, vendor)
	switch state {
	case "":
		return api.Install{}, &Invalid{fmt.Sprintf("%s 在 %s 上還沒安裝", p.Name, vendor)}
	case RecipeEdited:
		return api.Install{}, &Invalid{"啟動腳本手動改過，不會自動改寫；可以先改用主控台的啟動腳本"}
	}
	if image == "" {
		image = recommended
	} else if !offers(p, vendor, variant, image) {
		return api.Install{}, &Invalid{image + " 不是這個引擎提供的版本"}
	}
	if state == RecipeCurrent && image == recommended {
		return api.Install{}, &Invalid{"已經是這個版本"}
	}
	return in.rewrite(p, vendor, variant, image, "")
}

// Adopt rewrites a launcher edited by hand the way the console writes it,
// so its image can be switched from the page again. The edited one is kept
// beside it as <name>.edited-<time>, and its image is kept when the build
// still offers it; the next model start runs the new launcher.
func (in *Installer) Adopt(ctx context.Context, key, vendor string) (api.Install, error) {
	p, err := providers.Lookup(key)
	if err != nil {
		return api.Install{}, &Invalid{err.Error()}
	}
	state, _, _ := in.Recipe(p, vendor)
	switch state {
	case "":
		return api.Install{}, &Invalid{fmt.Sprintf("%s 在 %s 上還沒安裝", p.Name, vendor)}
	case RecipeCurrent, RecipeOutdated:
		return api.Install{}, &Invalid{"啟動腳本本來就是主控台寫的"}
	}
	raw, err := os.ReadFile(in.script(p, vendor))
	if err != nil {
		return api.Install{}, err
	}
	have := launcherImage(string(raw))
	variant := ""
	if p.Fallback != nil && have == p.Fallback.Image {
		variant = "vulkan"
	}
	spec := specFor(p, vendor, variant)
	if spec == nil {
		return api.Install{}, &Invalid{fmt.Sprintf("%s 沒有 %s 顯示卡的版本", p.Name, vendor)}
	}
	image := spec.Image
	if offers(p, vendor, variant, have) {
		image = have
	}
	return in.rewrite(p, vendor, variant, image, ".edited-"+time.Now().Format("20060102-150405"))
}

// rewrite pulls image and writes the launcher for it, in the background,
// reporting through the install record. keep, when set, is the suffix the
// launcher there now is copied to first.
func (in *Installer) rewrite(p providers.Provider, vendor, variant, image, keep string) (api.Install, error) {
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
		var err error
		if keep != "" {
			var old []byte
			if old, err = os.ReadFile(path); err == nil {
				err = os.WriteFile(path+keep, old, mode)
			}
		}
		tmp := path + ".tmp"
		if err == nil {
			err = os.WriteFile(tmp, []byte(withImage(WrapperText(p, vendor, in.ModelsDir, variant), image)), mode)
		}
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
			log.Printf("could not rewrite %s for %s: %v", p.Name, vendor, err)
			return
		}
		in.Probe.mu.Unlock()
		in.Probe.Usable(bg, true)
		in.Probe.mu.Lock()
		rec.State, rec.Message = "done", path
		in.Probe.mu.Unlock()
		log.Printf("wrote %s for %s on %s", p.Name, vendor, image)
	}()
	return *rec, nil
}
