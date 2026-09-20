package backends

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
	"github.com/NoobBandi/TenkStack/server-go/internal/providers"
	"github.com/NoobBandi/TenkStack/server-go/internal/vendors"
)

// Adding a runtime for a card that has none: the console writes a launcher
// script and a macro naming it, never a free-form command. The images are
// the official ones; building from source is right for exactly one card.

// Config is what the installer needs from the llama-swap config.
type Config interface {
	Launchers() []string
	LauncherMacros() map[string]string
	ModelsUsing(wrapper string) []string
	AddMacro(ctx context.Context, name, value string) error
	RemoveMacro(ctx context.Context, name string) error
}

// Images is what the installer needs from docker.
type Images interface {
	ImageSizes(ctx context.Context) map[string]string
	Pull(ctx context.Context, image string, progress api.Progress) bool
	RemoveImage(ctx context.Context, image string) bool
}

func strp(s string) *string { return &s }

// cardFlags are the vendor's device arguments without naming a card: the
// launcher serves whichever card its selector picks, so it is written with
// the passthrough for the machine and the selector narrows it inside.
func cardFlags(v vendors.Vendor) []string {
	flags := v.DeviceFlags(vendors.Card{}, nil)
	out := []string{}
	for i := 0; i < len(flags); i++ {
		if flags[i] == "--gpus" {
			out = append(out, "--gpus", "all")
			i++
			continue
		}
		out = append(out, flags[i])
	}
	return out
}

// template is one provider's build for one vendor as the API shows it:
// labelled with the vendor, flags filled in from the vendor when the build
// left them to it.
func template(p providers.Provider, v vendors.Vendor, b providers.Build) api.RuntimeTemplate {
	t := api.RuntimeTemplate{Label: v.Label, Image: b.Image, Verified: b.Verified, Vendor: v.Key, Provider: p.Key, Command: b.Command, CacheDir: b.CacheDir}
	if b.Requires != "" {
		t.Requires = strp(b.Requires)
	}
	if len(b.Flags) > 0 {
		t.Flags = append([]string{}, b.Flags...)
	} else {
		t.Flags = cardFlags(v)
	}
	return t
}

// Templates is one provider's image per vendor that has one.
func Templates(p providers.Provider) map[string]api.RuntimeTemplate {
	out := map[string]api.RuntimeTemplate{}
	for _, v := range vendors.All() {
		if b, ok := p.Builds[v.Key]; ok {
			out[v.Key] = template(p, v, b)
		}
	}
	return out
}

// Runtimes is llama.cpp's server image per vendor: the provider a card is
// switched on with, which is what the per-card view is about.
func Runtimes() map[string]api.RuntimeTemplate {
	return Templates(*providers.Get(providers.LlamaCpp))
}

func RuntimeFor(vendor string) *api.RuntimeTemplate {
	if t, ok := Runtimes()[vendor]; ok {
		return &t
	}
	return nil
}

// specFor is the template a launcher is written from: the provider's build
// for the vendor, or its fallback when that variant was asked for.
func specFor(p providers.Provider, vendor, variant string) *api.RuntimeTemplate {
	if variant == "vulkan" && p.Fallback != nil {
		t := api.RuntimeTemplate{
			Label: p.FallbackLabel, Image: p.Fallback.Image, Verified: p.Fallback.Verified,
			Flags: append([]string{}, p.Fallback.Flags...), Vendor: vendor, Provider: p.Key,
		}
		if p.Fallback.Requires != "" {
			t.Requires = strp(p.Fallback.Requires)
		}
		return &t
	}
	if t, ok := Templates(p)[vendor]; ok {
		return &t
	}
	return nil
}

// quote is shlex.quote: safe characters pass through, anything else is
// single-quoted.
// quote is shlex.quote: safe characters pass through, anything else is
// single-quoted.
func quote(s string) string {
	if s == "" {
		return "''"
	}
	for _, r := range s {
		safe := r == '_' || r == '@' || r == '%' || r == '+' || r == '=' || r == ':' || r == ',' || r == '.' || r == '/' || r == '-' ||
			(r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
		if !safe {
			return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
		}
	}
	return s
}

// WrapperText is the launcher script for one provider on one vendor. The
// models directory is mounted at the path it has on the host so entries
// move between this launcher and a native one unchanged, and the container
// runs with --network host so --port ${PORT} lands where llama-swap expects.
func WrapperText(p providers.Provider, vendor, modelsDir, variant string) string {
	spec := specFor(p, vendor, variant)
	if spec == nil {
		return ""
	}
	quoted := make([]string, len(spec.Flags))
	for i, f := range spec.Flags {
		quoted[i] = quote(f)
	}
	flags := strings.Join(quoted, " ")
	selector := ""
	if v := vendors.Get(vendor); v != nil {
		selector = v.SelectorVar
	}
	command := ""
	for _, word := range spec.Command {
		command += " " + quote(word)
	}
	forward, selectArg := "", ""
	if selector != "" {
		forward = fmt.Sprintf(`
# Forwarded only when it has a value. An empty %[1]s does not mean "no
# preference" -- it means *no devices*, and the container then reports that it
# cannot find a card on a machine where the card is fine.
SELECT=()
if [[ -n "${%[1]s:-}" ]]; then
  SELECT=(-e "%[1]s=$%[1]s")
fi
`, selector)
		selectArg = "  \"${SELECT[@]}\" \\\n"
	}
	// Beside the script, so it is deleted with it, and per launcher, so two
	// images never read each other's kernels.
	cache := ""
	if spec.CacheDir != "" {
		cache = fmt.Sprintf(`
# Compiled kernels, kept between runs.
CACHE_DIR="$(dirname "$(readlink -f "$0")")/cache/%s"
mkdir -p "$CACHE_DIR"
`, p.Macro(vendor))
		selectArg += fmt.Sprintf("  -v \"$CACHE_DIR:%s\" \\\n", spec.CacheDir)
	}
	return fmt.Sprintf(`#!/usr/bin/env bash
# %s for the %s card, in a container, generated by the
# console. Edit freely -- nothing regenerates this file once it exists.
#
# A container rather than a build on this host: a second vendor means a second
# userspace runtime beside the first, and installing them side by side is where
# that arrangement starts to rot. The kernel driver has to be on the host and
# cannot be anywhere else; everything above it belongs to the image.
set -euo pipefail

IMAGE="${%s_IMAGE:-%s}"
MODELS_DIR="%s"

# Named so `+"`cmdStop`"+` can reach it. llama-swap signals this script, and a
# `+"`docker run`"+` that is killed leaves its container running -- the signal has to
# arrive at the container instead, which is what `+"`docker stop`"+` does.
NAME="${%s_NAME:-%s}"
%s%s
exec docker run --rm --init \
  --name "$NAME" \
  %s \
  --network host \
%s  -v "$MODELS_DIR:$MODELS_DIR:ro" \
  "$IMAGE"%s "$@"
`, p.Program, spec.Label, p.EnvPrefix, spec.Image, modelsDir, p.EnvPrefix, p.Macro(vendor), cache, forward, flags, selectArg, command)
}

// Installer adds, updates, switches off and removes runtimes, so a fresh
// machine starts with nothing and holds only what somebody asked for.
type Installer struct {
	Probe     *Probe
	Config    Config
	Images    Images
	ScriptDir string
	ModelsDir string
}

var imageLine = regexp.MustCompile(`IMAGE="\$\{[A-Z_]+_IMAGE:-([^}"]+)\}"`)

func (in *Installer) script(p providers.Provider, vendor string) string {
	return filepath.Join(in.ScriptDir, p.ScriptName(vendor))
}

// slot is the key one (provider, vendor) pair has in the install table.
func slot(p providers.Provider, vendor string) string { return p.Key + "/" + vendor }

// Invalid is a request that cannot be carried out, worth a 400.
type Invalid struct{ Msg string }

func (e *Invalid) Error() string { return e.Msg }

type installProgress struct {
	p   *Probe
	rec *api.Install
}

func (ip installProgress) Layer(done, total int) {
	ip.p.mu.Lock()
	ip.rec.LayersDone, ip.rec.LayersTotal = done, total
	ip.p.mu.Unlock()
}
func (ip installProgress) Message(text string) {
	ip.p.mu.Lock()
	ip.rec.Message = text
	ip.p.mu.Unlock()
}
func (ip installProgress) Failed(text string) {
	ip.p.mu.Lock()
	ip.rec.State = "error"
	if text != "" {
		ip.rec.Message = text
	}
	ip.p.mu.Unlock()
}

func (in *Installer) install(p providers.Provider, vendor string) *api.Install {
	in.Probe.mu.Lock()
	defer in.Probe.mu.Unlock()
	if rec, ok := in.Probe.installs[slot(p, vendor)]; ok {
		copy := *rec
		return &copy
	}
	return nil
}

func (in *Installer) busy(p providers.Provider, vendor string) *api.Install {
	rec := in.install(p, vendor)
	if rec != nil && (rec.State == "pulling" || rec.State == "writing") {
		return rec
	}
	return nil
}

// State is what exists for one provider on one vendor: script, macro,
// image, independently.
func (in *Installer) State(ctx context.Context, key, vendor string) api.RuntimeState {
	p, err := providers.Lookup(key)
	if err != nil {
		return api.RuntimeState{UsedBy: []string{}}
	}
	script := in.script(p, vendor)
	macro := p.Macro(vendor)
	_, err = os.Stat(script)
	managed := err == nil
	st := api.RuntimeState{Managed: managed, UsedBy: in.Config.ModelsUsing("${" + macro + "}"), Install: in.install(p, vendor)}
	st.Enabled = in.Config.LauncherMacros()[macro] == script
	// From the script when there is one: it records which variant was chosen.
	if spec := specFor(p, vendor, "vendor"); spec != nil {
		img := spec.Image
		st.Image = &img
	}
	if managed {
		if b, err := os.ReadFile(script); err == nil {
			if m := imageLine.FindSubmatch(b); m != nil {
				img := string(m[1])
				st.Image = &img
			}
		}
	}
	if st.Image != nil {
		if size, ok := in.Images.ImageSizes(ctx)[*st.Image]; ok {
			st.ImageSize = &size
		}
	}
	return st
}

// Install pulls the image, writes the launcher, and names it in the config.
func (in *Installer) Install(ctx context.Context, key, vendor, variant string) (api.Install, error) {
	p, err := providers.Lookup(key)
	if err != nil {
		return api.Install{}, &Invalid{err.Error()}
	}
	spec := specFor(p, vendor, variant)
	if spec == nil {
		return api.Install{}, &Invalid{fmt.Sprintf("%s 沒有 %s 顯示卡的版本", p.Name, vendor)}
	}
	if running := in.busy(p, vendor); running != nil {
		return *running, nil
	}
	path := in.script(p, vendor)
	if _, err := os.Stat(path); err == nil {
		return api.Install{}, &Invalid{filepath.Base(path) + " 已經存在，沒有覆寫它"}
	}
	rec := &api.Install{Provider: p.Key, Vendor: vendor, Image: spec.Image, State: "pulling"}
	in.Probe.mu.Lock()
	in.Probe.installs[slot(p, vendor)] = rec
	in.Probe.mu.Unlock()

	go func() {
		bg := context.Background()
		if !in.Images.Pull(bg, spec.Image, installProgress{in.Probe, rec}) {
			return
		}
		in.Probe.mu.Lock()
		rec.State = "writing"
		in.Probe.mu.Unlock()
		err := os.WriteFile(path, []byte(WrapperText(p, vendor, in.ModelsDir, variant)), 0o755)
		if err == nil {
			err = in.Config.AddMacro(bg, p.Macro(vendor), path)
		}
		in.Probe.mu.Lock()
		if err != nil {
			rec.State, rec.Message = "error", err.Error()
			in.Probe.mu.Unlock()
			log.Printf("could not register %s for %s: %v", p.Name, vendor, err)
			return
		}
		in.Probe.mu.Unlock()
		// A new launcher is exactly what invalidates the probe's cache.
		in.Probe.Usable(bg, true)
		in.Probe.mu.Lock()
		rec.State, rec.Message = "done", path
		in.Probe.mu.Unlock()
	}()
	return *rec, nil
}

// Enable registers or unregisters the macro, leaving the files alone. Off
// is how a card is taken out of service without throwing away gigabytes.
func (in *Installer) Enable(ctx context.Context, key, vendor string, on bool) error {
	p, err := providers.Lookup(key)
	if err != nil {
		return &Invalid{err.Error()}
	}
	script := in.script(p, vendor)
	macro := p.Macro(vendor)
	if on {
		if _, err := os.Stat(script); err != nil {
			return &Invalid{filepath.Base(script) + " 不存在，先安裝再啟用"}
		}
		if err := in.Config.AddMacro(ctx, macro, script); err != nil {
			return err
		}
	} else {
		if used := in.Config.ModelsUsing("${" + macro + "}"); len(used) > 0 {
			return &Invalid{"還有模型用這個執行環境啟動：" + strings.Join(used, "、") + "。先把它們改到別張卡，或刪掉它們。"}
		}
		if err := in.Config.RemoveMacro(ctx, macro); err != nil {
			return err
		}
	}
	in.Probe.Usable(ctx, true)
	return nil
}

// Remove unregisters, deletes the launcher, and optionally reclaims the
// image, which is separate on purpose: only one of them is slow to undo.
func (in *Installer) Remove(ctx context.Context, key, vendor string, deleteImage bool) error {
	p, err := providers.Lookup(key)
	if err != nil {
		return &Invalid{err.Error()}
	}
	if err := in.Enable(ctx, key, vendor, false); err != nil {
		return err
	}
	script := in.script(p, vendor)
	if deleteImage {
		if img := in.State(ctx, key, vendor).Image; img != nil {
			in.Images.RemoveImage(ctx, *img)
		}
	}
	os.Remove(script)
	in.Probe.mu.Lock()
	delete(in.Probe.installs, slot(p, vendor))
	in.Probe.mu.Unlock()
	in.Probe.Usable(ctx, true)
	return nil
}

// Update pulls the image again; the tags are rolling, so that is the whole
// of updating a containerised runtime.
func (in *Installer) Update(ctx context.Context, key, vendor string) (api.Install, error) {
	p, err := providers.Lookup(key)
	if err != nil {
		return api.Install{}, &Invalid{err.Error()}
	}
	img := in.State(ctx, key, vendor).Image
	if img == nil {
		return api.Install{}, &Invalid{fmt.Sprintf("%s 沒有 %s 顯示卡的版本", p.Name, vendor)}
	}
	if running := in.busy(p, vendor); running != nil {
		return *running, nil
	}
	rec := &api.Install{Provider: p.Key, Vendor: vendor, Image: *img, State: "pulling"}
	in.Probe.mu.Lock()
	in.Probe.installs[slot(p, vendor)] = rec
	in.Probe.mu.Unlock()
	go func() {
		if in.Images.Pull(context.Background(), *img, installProgress{in.Probe, rec}) {
			in.Probe.mu.Lock()
			rec.State = "done"
			in.Probe.mu.Unlock()
		}
	}()
	return *rec, nil
}

// Coverage is what each card is currently allowed to do: one row per card,
// every field observed. held maps a PCI bus key to the containers on it.
func (in *Installer) Coverage(ctx context.Context, cards []api.GpuDevice, held map[string][]api.HeldContainer, busKey func(string) string) []api.RuntimeRow {
	driven := map[string]bool{}
	for _, d := range Match(in.Probe.Usable(ctx, false), cards) {
		if d.PCIBDFAddress != nil && *d.PCIBDFAddress != "" {
			driven[busKey(*d.PCIBDFAddress)] = true
		}
	}
	sameVendor := map[string]int{}
	for _, c := range cards {
		sameVendor[c.Vendor]++
	}
	runtimes := Runtimes()
	rows := []api.RuntimeRow{}
	for _, c := range cards {
		address := ""
		if c.PCIBDFAddress != nil {
			address = *c.PCIBDFAddress
		}
		boxes := []api.HeldContainer{}
		if address != "" {
			if b, ok := held[busKey(address)]; ok {
				boxes = b
			}
		}
		images := false
		for _, b := range boxes {
			if b.State != nil && *b.State == "running" {
				images = true
			}
		}
		row := api.RuntimeRow{
			PCIBDFAddress: c.PCIBDFAddress, Name: c.Name, Vendor: c.Vendor,
			LLM: address != "" && driven[busKey(address)], Containers: boxes, Images: images,
			// A launcher belongs to a backend, not a card: with two cards of
			// one vendor the model switch moves both.
			SharedSwitch: sameVendor[c.Vendor] > 1,
		}
		if t, ok := runtimes[c.Vendor]; ok {
			row.Runtime = &t
			st := in.State(ctx, providers.LlamaCpp, c.Vendor)
			row.State = &st
		}
		rows = append(rows, row)
	}
	return rows
}
