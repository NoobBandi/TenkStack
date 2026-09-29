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

// Ask runs the setup screens and returns the answers, starting from the
// preset (the flags install.sh was given).
func Ask(m Machine, preset Answers) (Answers, error) {
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
			huh.NewNote().Title(T(l, "review.title")).DescriptionFunc(func() string {
				return review(l, m, engines, a, access)
			}, &a),
			huh.NewConfirm().Affirmative(T(l, "review.continue")).Negative(T(l, "review.cancel")).Value(&proceed),
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

// review is the last screen's summary of the choices.
func review(l Lang, m Machine, engines []Engine, a Answers, access string) string {
	names := map[string]string{}
	for _, e := range engines {
		names[e.Key] = e.Name
	}
	list := func(items []string, name func(string) string) string {
		if len(items) == 0 {
			return T(l, "review.none")
		}
		var out []string
		for _, it := range items {
			out = append(out, name(it))
		}
		return strings.Join(out, ", ")
	}
	cards := map[string]string{}
	for _, c := range m.Cards {
		cards[c.Address] = c.Name + " (" + c.Address + ")"
	}
	accessText := T(l, "access.http")
	switch access {
	case "internal":
		accessText = T(l, "access.internal")
	case "domain":
		accessText = Tf(l, "review.domain", a.Domain)
	}
	yn := T(l, "no")
	if a.SearXNG {
		yn = T(l, "yes")
	}
	rows := [][2]string{
		{T(l, "review.dir"), a.Root},
		{T(l, "review.engines"), list(a.Engines, func(k string) string { return names[k] })},
		{T(l, "review.comfy"), list(a.Comfy, func(k string) string { return cards[k] })},
		{T(l, "review.searxng"), yn},
		{T(l, "review.access"), accessText},
	}
	var b strings.Builder
	for _, r := range rows {
		fmt.Fprintf(&b, "%s: %s\n", r[0], r[1])
	}
	b.WriteString("\n" + T(l, "review.next"))
	return b.String()
}
