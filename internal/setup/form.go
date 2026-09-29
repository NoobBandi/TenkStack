package setup

import (
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"
)

// ErrCancelled is the user leaving the setup without an answer.
var ErrCancelled = errors.New("cancelled")

// AskLanguage is the first screen: which language the rest is in.
func AskLanguage(preset Lang) (Lang, error) {
	chosen := preset
	if chosen == "" {
		chosen = DefaultLang()
	}
	err := huh.NewForm(huh.NewGroup(
		huh.NewSelect[Lang]().
			Title(T(English, "lang.title")).
			Description("The installer and its messages will use this language.\n安裝程式與之後的訊息都會用這個語言。").
			Options(huh.NewOption("English", English), huh.NewOption("繁體中文", Chinese)).
			Value(&chosen),
	)).WithTheme(huh.ThemeCharm()).WithKeyMap(keyMap(English)).Run()
	if err != nil {
		return "", cancelled(err)
	}
	return chosen, nil
}

func cancelled(err error) error {
	if errors.Is(err, huh.ErrUserAborted) {
		return ErrCancelled
	}
	return err
}

// AskAction offers install or uninstall when an install is already here.
func AskAction(l Lang, root string) (string, error) {
	action := "install"
	err := huh.NewForm(huh.NewGroup(
		huh.NewSelect[string]().Title(T(l, "action.title")).Description(Tf(l, "action.found", root)).
			Options(huh.NewOption(T(l, "action.install"), "install"), huh.NewOption(T(l, "action.uninstall"), "uninstall")).
			Value(&action),
	)).WithTheme(huh.ThemeCharm()).WithKeyMap(keyMap(l)).Run()
	if err != nil {
		return "", cancelled(err)
	}
	return action, nil
}

// AskUninstall asks what an uninstall keeps.
func AskUninstall(l Lang, root string) (Answers, error) {
	a := Answers{Lang: l, Action: "uninstall", Root: root}
	keep := "keep"
	removeImages := true
	err := huh.NewForm(huh.NewGroup(
		huh.NewSelect[string]().Title(T(l, "un.keep.title")+": "+root).Description(T(l, "un.keep.desc")).
			Options(huh.NewOption(T(l, "un.keep.keep"), "keep"), huh.NewOption(T(l, "un.keep.purge"), "purge")).
			Value(&keep),
		huh.NewConfirm().Title(T(l, "un.images.title")).Description(T(l, "un.images.desc")+"\n\n"+T(l, "un.next")).
			Affirmative(T(l, "yes")).Negative(T(l, "no")).Value(&removeImages),
	)).WithTheme(huh.ThemeCharm()).WithKeyMap(keyMap(l)).Run()
	if err != nil {
		return Answers{}, cancelled(err)
	}
	a.Purge = keep == "purge"
	a.KeepImages = !removeImages
	return a, nil
}

// help labels in Chinese, by huh's English ones.
var helpZh = map[string]string{
	"next": "下一步", "back": "上一步", "toggle": "勾選", "select all": "全選", "select none": "全不選",
	"submit": "完成", "confirm": "確定", "select": "選擇", "up": "上", "down": "下",
	"filter": "篩選", "Yes": "是", "No": "否", "left": "左", "right": "右",
}

// keyMap is huh's, its help line in the chosen language. Ticking a box
// is labelled with the space bar, which the first screen tells people to
// use; x does the same.
func keyMap(l Lang) *huh.KeyMap {
	km := huh.NewDefaultKeyMap()
	km.MultiSelect.Toggle.SetHelp("space", km.MultiSelect.Toggle.Help().Desc)
	// Every list here is a handful of lines; a filter is one more thing
	// to explain.
	for _, b := range []*key.Binding{&km.Select.Filter, &km.Select.SetFilter, &km.Select.ClearFilter,
		&km.MultiSelect.Filter, &km.MultiSelect.SetFilter, &km.MultiSelect.ClearFilter} {
		b.SetEnabled(false)
	}
	if l != Chinese {
		return km
	}
	var walk func(v reflect.Value)
	walk = func(v reflect.Value) {
		for i := 0; i < v.NumField(); i++ {
			f := v.Field(i)
			if b, ok := f.Addr().Interface().(*key.Binding); ok {
				if zh, ok := helpZh[b.Help().Desc]; ok {
					b.SetHelp(b.Help().Key, zh)
				}
				continue
			}
			if f.Kind() == reflect.Struct {
				walk(f)
			}
		}
	}
	walk(reflect.ValueOf(km).Elem())
	// On a yes/no field the arrows switch the answer; nothing is ticked.
	km.Confirm.Toggle.SetHelp(km.Confirm.Toggle.Help().Key, "切換")
	return km
}

var domainName = regexp.MustCompile(`^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$`)

// summary is the machine in a few lines, for the first screen.
func summary(l Lang, m Machine) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s: %s", T(l, "welcome.found"), m.OS)
	if m.RAMGiB > 0 {
		fmt.Fprintf(&b, " · %s %d GB", T(l, "welcome.ram"), m.RAMGiB)
	}
	b.WriteString("\n")
	if len(m.Cards) == 0 {
		b.WriteString("  " + T(l, "welcome.nocards") + "\n")
	}
	for _, c := range m.Cards {
		fmt.Fprintf(&b, "  %s · %s\n", c.Name, c.Address)
	}
	b.WriteString("\n" + T(l, "welcome.keys"))
	return b.String()
}

// Ask runs the install screens and returns the answers, starting from the
// preset (the flags install.sh was given). The last screen is the only
// confirmation: it lists every change to the machine from the survey's facts.
func Ask(m Machine, preset Answers, facts Facts) (Answers, error) {
	l := preset.Lang
	a := preset
	engines := EnginesFor(m.Vendors())

	access := a.TLS
	proceed := true

	groups := []*huh.Group{
		huh.NewGroup(
			huh.NewNote().Title(T(l, "welcome.title")).Description(summary(l, m)),
			huh.NewInput().Title(T(l, "dir.title")).Description(T(l, "dir.desc")).
				Value(&a.Root).Validate(func(s string) error {
				s = strings.TrimSpace(s)
				if s == "" {
					return errors.New(T(l, "dir.empty"))
				}
				if !filepath.IsAbs(s) && !strings.HasPrefix(s, "~/") {
					return errors.New(T(l, "dir.relative"))
				}
				return nil
			}),
		),
	}

	if len(engines) > 0 {
		var opts []huh.Option[string]
		chosen := map[string]bool{}
		for _, k := range a.Engines {
			chosen[k] = true
		}
		for _, e := range engines {
			label := e.Name + " — " + T(l, "engine."+e.Key)
			if e.Default {
				label += " · " + T(l, "engine.required")
			}
			if !e.Verified {
				label += " · " + T(l, "engine.unverified")
			}
			opts = append(opts, huh.NewOption(label, e.Key).Selected(chosen[e.Key]))
		}
		groups = append(groups, huh.NewGroup(
			huh.NewMultiSelect[string]().Title(T(l, "engines.title")).Description(T(l, "engines.desc")).
				Options(opts...).Value(&a.Engines).Filterable(false),
		))
	}

	if len(m.Cards) > 0 {
		desc := T(l, "comfy.desc")
		for _, v := range m.Vendors() {
			if v == "intel" && !m.XPUSMI {
				desc += "\n" + T(l, "comfy.xpusmi")
			}
		}
		var opts []huh.Option[string]
		chosen := map[string]bool{}
		for _, c := range a.Comfy {
			chosen[c] = true
		}
		for _, c := range m.Cards {
			opts = append(opts, huh.NewOption(c.Name+" · "+c.Address, c.Address).Selected(chosen[c.Address]))
		}
		groups = append(groups, huh.NewGroup(
			huh.NewMultiSelect[string]().Title(T(l, "comfy.title")).Description(desc).
				Options(opts...).Value(&a.Comfy).Filterable(false),
		))
	}

	groups = append(groups,
		huh.NewGroup(
			huh.NewConfirm().Title(T(l, "searxng.title")).Description(T(l, "searxng.desc")).
				Affirmative(T(l, "yes")).Negative(T(l, "no")).Value(&a.SearXNG),
			huh.NewSelect[string]().Title(T(l, "access.title")).
				Options(
					huh.NewOption(T(l, "access.http"), ""),
					huh.NewOption(T(l, "access.internal"), "internal"),
					huh.NewOption(T(l, "access.domain"), "domain"),
				).Value(&access),
		),
		huh.NewGroup(
			huh.NewInput().Title(T(l, "domain.title")).Placeholder("ai.example.com").Value(&a.Domain).
				Validate(func(s string) error {
					if !domainName.MatchString(strings.TrimSpace(s)) {
						return errors.New(T(l, "domain.invalid"))
					}
					return nil
				}),
		).WithHideFunc(func() bool { return access != "domain" }),
		huh.NewGroup(
			// A fixed height, the most it can take: the text grows with the
			// choices after the page is laid out, and huh would crop it.
			huh.NewNote().Title(T(l, "review.title")).DescriptionFunc(func() string {
				c := a
				c.TLS = access
				return review(l, m, engines, c, facts)
			}, []any{&a, &access}).Height(reviewHeight(l, m, engines, facts)),
			huh.NewConfirm().Affirmative(startLabel(l, facts)).Negative(T(l, "review.cancel")).Value(&proceed).
				Validate(func(start bool) error {
					c := a
					c.TLS = access
					if busy := facts.Busy(c); start && len(busy) > 0 {
						return errors.New(Tf(l, "review.busy", strings.Join(busy, ", ")))
					}
					return nil
				}),
		),
	)

	err := huh.NewForm(groups...).WithTheme(huh.ThemeCharm()).WithKeyMap(keyMap(l)).Run()
	if err != nil {
		return Answers{}, cancelled(err)
	}
	if !proceed {
		return Answers{}, ErrCancelled
	}
	a.TLS = access
	a.Root = strings.TrimSpace(a.Root)
	if a.TLS != "domain" {
		a.Domain = ""
	}
	a.Domain = strings.TrimSpace(a.Domain)
	return a, nil
}

// reviewHeight is the most lines the confirmation can take on this machine:
// every engine and card ticked, the longest list of system changes any
// access mode brings, and the two notes under the box.
func reviewHeight(l Lang, m Machine, engines []Engine, f Facts) int {
	changes := 0
	for _, tls := range []string{"", "internal", "domain"} {
		changes = max(changes, len(f.Changes(l, Answers{TLS: tls})))
	}
	// title, blank, two borders; location, blank, heading, base line,
	// SearXNG, blank, two access lines, blank, heading, reboot line
	return 4 + 12 + len(engines) + max(len(m.Cards), 1) + max(changes, 1) + 2
}

func startLabel(l Lang, f Facts) string {
	if f.DryRun {
		return T(l, "review.start.dry")
	}
	return T(l, "review.start")
}

var (
	styleOK   = lipgloss.NewStyle().Foreground(lipgloss.Color("10"))
	styleWarn = lipgloss.NewStyle().Foreground(lipgloss.Color("11"))
	styleErr  = lipgloss.NewStyle().Foreground(lipgloss.Color("9")).Bold(true)
	styleDim  = lipgloss.NewStyle().Faint(true)
	styleHead = lipgloss.NewStyle().Bold(true)
	styleBox  = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).Padding(0, 1)
)

// pad right-pads to a display width, counting wide characters as two.
func pad(s string, width int) string {
	if w := lipgloss.Width(s); w < width {
		return s + strings.Repeat(" ", width-w)
	}
	return s
}

// review is the confirmation: where, what, how it is reached, and what
// changes on the machine beyond the install directory.
func review(l Lang, m Machine, engines []Engine, a Answers, f Facts) string {
	var lines []string
	add := func(s ...string) { lines = append(lines, s...) }
	label := func(k string) string { return pad(T(l, k), 8) }
	vendorName := map[string]string{"intel": "Intel", "nvidia": "NVIDIA", "amd": "AMD"}

	add(label("review.location")+" "+a.Root, "")

	add(styleHead.Render(T(l, "review.installs")))
	chosen := map[string]bool{}
	for _, k := range a.Engines {
		chosen[k] = true
	}
	width := lipgloss.Width("SearXNG")
	for _, e := range engines {
		width = max(width, lipgloss.Width(e.Name))
	}
	width += 2
	add("  " + styleOK.Render("✓") + " " + T(l, "review.base"))
	for _, e := range engines {
		if !chosen[e.Key] {
			continue
		}
		var vs []string
		for _, v := range e.Vendors {
			vs = append(vs, vendorName[v])
		}
		add("  " + styleOK.Render("✓") + " " + pad(e.Name, width) + strings.Join(vs, ", "))
	}
	for _, c := range a.Comfy {
		add("  " + styleOK.Render("✓") + " " + pad("ComfyUI", width) + c)
	}
	if len(a.Comfy) == 0 {
		add("  " + styleDim.Render("· "+pad("ComfyUI", width)+T(l, "review.skip")))
	}
	if a.SearXNG {
		add("  " + styleOK.Render("✓") + " " + pad("SearXNG", width) + "127.0.0.1:" + f.SearXNGPort)
	} else {
		add("  " + styleDim.Render("· "+pad("SearXNG", width)+T(l, "review.skip")))
	}
	add("")

	var url, how string
	switch a.TLS {
	case "internal":
		url, how = "https://"+f.Host+":"+f.TLSPort, T(l, "review.how.internal")
	case "domain":
		url, how = "https://"+a.Domain, T(l, "review.how.domain")
	default:
		url, how = "http://"+f.Host+":"+f.TLSPort, T(l, "review.how.http")
	}
	add(label("review.access")+" "+url, pad("", 8)+" "+styleDim.Render(how), "")

	add(styleHead.Render(T(l, "review.system")))
	changes := f.Changes(l, a)
	if len(changes) == 0 {
		add("  " + styleOK.Render("✓") + " " + T(l, "review.nosystem"))
	}
	for _, c := range changes {
		mark := styleOK.Render("✓")
		text := c.Text
		if c.Sudo {
			mark = styleWarn.Render("!")
			text += styleDim.Render("  sudo")
		}
		add("  " + mark + " " + text)
	}
	if f.NeedsReboot {
		add("  " + styleWarn.Render("!") + " " + Tf(l, "review.reboot", f.RebootWhy))
	} else if len(f.MissingGroups) > 0 {
		add("  " + styleWarn.Render("!") + " " + T(l, "review.relogin"))
	} else {
		add("  " + styleOK.Render("✓") + " " + T(l, "review.noreboot"))
	}

	out := styleBox.Render(strings.Join(lines, "\n"))
	if busy := f.Busy(a); len(busy) > 0 {
		out += "\n" + styleErr.Render(Tf(l, "review.busy", strings.Join(busy, ", ")))
	}
	if f.DryRun {
		out += "\n" + styleDim.Render(T(l, "review.dry"))
	}
	return out
}
