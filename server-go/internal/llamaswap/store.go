package llamaswap

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

// FallbackWrapper is the historical launcher name, used only when nothing
// says which and there is more than one to choose from.
const FallbackWrapper = "${llama-sycl}"

// How long llama-swap may take to notice a write and say what it thought.
const reloadTimeout = 10 * time.Second

// What llama-swap logs about a config it has just read: the only place the
// outcome appears. A rejected config leaves the previous one serving, which
// looks exactly like success.
const (
	reloaded = "configuration reloaded"
	rejected = "failed to reload config"
)

// Rejected is llama-swap refusing a config; the file has been put back.
var Rejected = errors.New("llama-swap 不接受這份設定，已還原成修改前的內容。詳細原因在 llama-swap 的日誌裡（設定沒有被套用）。")

// Store is llama-swap's config file: the single source of truth for which
// models exist and how they start.
type Store struct {
	Path string
	// SkipVerdict writes without asking llama-swap, for tests on a file it
	// is not watching.
	SkipVerdict bool
	mu          sync.Mutex

	aliasMu    sync.Mutex
	aliases    map[string]string
	aliasStamp time.Time
}

func NewStore(path string) *Store { return &Store{Path: path} }

func (s *Store) Load() (*Config, error) { return Load(s.Path) }

func (s *Store) Raw() (string, error) {
	b, err := os.ReadFile(s.Path)
	return string(b), err
}

// Section decodes one top-level mapping into plain values, for the API.
func Section(c *Config, key string) map[string]any {
	out := map[string]any{}
	if n := c.Root().Get(key); n != nil && n.Kind == yaml.MappingNode {
		_ = n.Decode(&out)
	}
	return out
}

// Macros are the config's macro table as strings.
func Macros(c *Config) map[string]string {
	out := map[string]string{}
	if m := c.Root().Map("macros"); m != nil {
		for _, key := range m.Keys() {
			out[key] = Scalar(m.Get(key))
		}
	}
	return out
}

// LauncherMacros are the macros that name an executable: the inverse lookup
// the device picker needs.
func (s *Store) LauncherMacros() map[string]string {
	c, err := s.Load()
	if err != nil {
		log.Printf("could not read the config while listing launchers: %v", err)
		return map[string]string{}
	}
	out := map[string]string{}
	for name, value := range Macros(c) {
		if p := expandHome(value); isExecutable(p) {
			out[name] = p
		}
	}
	return out
}

func expandHome(p string) string {
	if strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, p[2:])
		}
	}
	return p
}

func isExecutable(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular() && st.Mode()&0o111 != 0
}

// Launcher is one macro that names an executable.
type Launcher struct {
	Name string
	Path string
}

// LauncherList is LauncherMacros in the config's own order.
func (s *Store) LauncherList() []Launcher {
	c, err := s.Load()
	if err != nil {
		return nil
	}
	var out []Launcher
	if m := c.Root().Map("macros"); m != nil {
		for _, key := range m.Keys() {
			if p := expandHome(Scalar(m.Get(key))); isExecutable(p) {
				out = append(out, Launcher{key, p})
			}
		}
	}
	return out
}

// WrapperFor is ${macro} for a launcher path, or "" if no macro names it.
func (s *Store) WrapperFor(launcher string) string {
	if launcher == "" {
		return ""
	}
	for name, path := range s.LauncherMacros() {
		if path == launcher {
			return "${" + name + "}"
		}
	}
	return ""
}

// DefaultWrapper is the launcher when nothing has said which: the only one
// when there is one, else the historical name.
func (s *Store) DefaultWrapper() string {
	macros := s.LauncherMacros()
	if len(macros) == 1 {
		for name := range macros {
			return "${" + name + "}"
		}
	}
	return FallbackWrapper
}

// Launchers are the commands that start a model, one per distinct launcher:
// every macro naming an executable, and the first word of every model's
// cmd with macros expanded.
func (s *Store) Launchers() []string {
	c, err := s.Load()
	if err != nil {
		log.Printf("could not read the config while looking for launchers: %v", err)
		return nil
	}
	macros := Macros(c)
	var found []string
	seen := map[string]bool{}
	if m := c.Root().Map("macros"); m != nil {
		for _, key := range m.Keys() {
			if p := macros[key]; isExecutable(p) && !seen[p] {
				found = append(found, p)
				seen[p] = true
			}
		}
	}
	if models := c.Root().Map("models"); models != nil {
		for _, id := range models.Keys() {
			spec := models.Map(id)
			if spec == nil {
				continue
			}
			text := strings.TrimSpace(Scalar(spec.Get("cmd")))
			if text == "" {
				continue
			}
			first := strings.TrimSpace(strings.SplitN(text, "\n", 2)[0])
			for key, value := range macros {
				first = strings.ReplaceAll(first, "${"+key+"}", value)
			}
			if first == "" || strings.Contains(first, "${") {
				continue
			}
			if launcher := firstWord(first); launcher != "" && !seen[launcher] {
				found = append(found, launcher)
				seen[launcher] = true
			}
		}
	}
	return found
}

// firstWord is the first shell word, honouring a quoted path.
func firstWord(s string) string {
	if s == "" {
		return ""
	}
	if q := s[0]; q == '"' || q == '\'' {
		if end := strings.IndexByte(s[1:], q); end >= 0 {
			return s[1 : 1+end]
		}
		return s[1:]
	}
	return strings.Fields(s)[0]
}

// The launcher reference at the head of a cmd: ${llama-sycl}.
var wrapperLine = regexp.MustCompile(`(?m)^\s*(\$\{[^}]+\})\s*$`)

func WrapperIn(cmd string) string {
	if m := wrapperLine.FindStringSubmatch(cmd); m != nil {
		return m[1]
	}
	return ""
}

// ModelsUsing lists the models started through a launcher, asked before
// unregistering one.
func (s *Store) ModelsUsing(wrapper string) []string {
	out := []string{}
	c, err := s.Load()
	if err != nil {
		log.Printf("could not read the config while checking launcher use: %v", err)
		return out
	}
	if models := c.Root().Map("models"); models != nil {
		for _, id := range models.Keys() {
			if spec := models.Map(id); spec != nil && WrapperIn(Scalar(spec.Get("cmd"))) == wrapper {
				out = append(out, id)
			}
		}
	}
	return out
}

// EnvPairs is a model entry's env as the list of NAME=value strings
// llama-swap wants; a mapping is accepted and flattened.
func EnvPairs(n *yaml.Node) []string {
	if n == nil {
		return nil
	}
	switch n.Kind {
	case yaml.MappingNode:
		m := &Mapping{n}
		var out []string
		for _, key := range m.Keys() {
			out = append(out, key+"="+Scalar(m.Get(key)))
		}
		return out
	case yaml.SequenceNode:
		return Strings(n)
	}
	return nil
}

func EnvMap(n *yaml.Node) map[string]string {
	out := map[string]string{}
	for _, item := range EnvPairs(n) {
		name, value, _ := strings.Cut(item, "=")
		out[name] = value
	}
	return out
}

// CanonicalModel follows aliases to the config key a request's model names,
// so an already-loaded model is not mistaken for an absent one.
func (s *Store) CanonicalModel(name string) string {
	st, err := os.Stat(s.Path)
	if err != nil {
		return name
	}
	s.aliasMu.Lock()
	defer s.aliasMu.Unlock()
	if !st.ModTime().Equal(s.aliasStamp) {
		c, err := s.Load()
		if err != nil {
			log.Printf("could not read the config while resolving aliases: %v", err)
			return name
		}
		aliases := map[string]string{}
		if models := c.Root().Map("models"); models != nil {
			for _, id := range models.Keys() {
				if spec := models.Map(id); spec != nil {
					for _, alias := range Strings(spec.Get("aliases")) {
						aliases[alias] = id
					}
				}
			}
		}
		s.aliases, s.aliasStamp = aliases, st.ModTime()
	}
	if id, ok := s.aliases[name]; ok {
		return id
	}
	return name
}

func journal(ctx context.Context, args ...string) (string, bool) {
	full := append([]string{"--user", "-u", "llama-swap.service", "--no-pager"}, args...)
	out, err := exec.CommandContext(ctx, "journalctl", full...).Output()
	if err != nil {
		return "", false
	}
	return string(out), true
}

// mark is a cursor for the last line llama-swap has logged. A cursor
// rather than a timestamp: --since is one second coarse, and the second
// holding the write also holds the reload of whatever came before.
func mark(ctx context.Context) string {
	text, ok := journal(ctx, "-n", "1", "-o", "cat", "--show-cursor")
	if !ok {
		return ""
	}
	lines := strings.Split(text, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.HasPrefix(lines[i], "-- cursor:") {
			return strings.TrimSpace(strings.TrimPrefix(lines[i], "-- cursor:"))
		}
	}
	return ""
}

// accepted says whether llama-swap took the config written just now: true,
// false, or nil when no verdict arrives. Unknown must not block an edit.
func accepted(ctx context.Context, cursor string) *bool {
	if cursor == "" {
		return nil
	}
	deadline := time.Now().Add(reloadTimeout)
	for time.Now().Before(deadline) {
		text, ok := journal(ctx, "--after-cursor", cursor, "-o", "cat")
		if !ok {
			return nil
		}
		if strings.Contains(text, rejected) {
			return boolp(false)
		}
		if strings.Contains(text, reloaded) {
			return boolp(true)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(500 * time.Millisecond):
		}
	}
	return nil
}

func boolp(b bool) *bool { return &b }

func writeAtomic(path, text string) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(text), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Apply writes a config and puts the previous one back if llama-swap will
// not have it. Only llama-swap knows its own schema, so it is asked.
func (s *Store) Apply(ctx context.Context, c *Config) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.applyLocked(ctx, c)
}

func (s *Store) applyLocked(ctx context.Context, c *Config) error {
	previous, err := os.ReadFile(s.Path)
	if err != nil {
		return err
	}
	cursor := ""
	if !s.SkipVerdict {
		cursor = mark(ctx)
	}
	if err := c.Save(s.Path); err != nil {
		return err
	}
	return s.verdict(ctx, cursor, string(previous))
}

func (s *Store) verdict(ctx context.Context, cursor, previous string) error {
	if s.SkipVerdict {
		return nil
	}
	switch ok := accepted(ctx, cursor); {
	case ok == nil:
		log.Print("no reload verdict from llama-swap; leaving the config in place")
	case !*ok:
		if err := writeAtomic(s.Path, previous); err != nil {
			return err
		}
		log.Print("llama-swap did not accept the new config; rolled back")
		return Rejected
	}
	return nil
}

// Edit loads the config, lets fn change it, and applies the result under
// the store's lock.
func (s *Store) Edit(ctx context.Context, fn func(c *Config) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, err := Load(s.Path)
	if err != nil {
		return err
	}
	if err := fn(c); err != nil {
		return err
	}
	return s.applyLocked(ctx, c)
}

// AddMacro names a launcher in the config so the device probe finds it.
func (s *Store) AddMacro(ctx context.Context, name, value string) error {
	changed := false
	err := s.Edit(ctx, func(c *Config) error {
		macros := c.Root().EnsureMap("macros")
		if Scalar(macros.Get(name)) == value {
			return errSkip
		}
		macros.Set(name, Str(value))
		changed = true
		return nil
	})
	if errors.Is(err, errSkip) {
		return nil
	}
	if err == nil && changed {
		log.Printf("registered launcher macro %s -> %s", name, value)
	}
	return err
}

// RemoveMacro takes a launcher's name out of the config.
func (s *Store) RemoveMacro(ctx context.Context, name string) error {
	err := s.Edit(ctx, func(c *Config) error {
		macros := c.Root().Map("macros")
		if macros == nil || !macros.Has(name) {
			return errSkip
		}
		macros.Delete(name)
		return nil
	})
	if errors.Is(err, errSkip) {
		return nil
	}
	if err == nil {
		log.Printf("removed launcher macro %s", name)
	}
	return err
}

// errSkip is an edit that turned out to change nothing.
var errSkip = errors.New("no change")

// ParseError is text that is not YAML, refused before it reaches the file.
type ParseError struct{ Err error }

func (e *ParseError) Error() string { return fmt.Sprintf("YAML 無法解析：%v", e.Err) }

// WriteRaw replaces the whole file after checking it parses, keeping a
// .bak of what was there and rolling back if llama-swap refuses it.
func (s *Store) WriteRaw(ctx context.Context, text string) error {
	var probe yaml.Node
	if err := yaml.Unmarshal([]byte(text), &probe); err != nil {
		return &ParseError{err}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, err := os.ReadFile(s.Path)
	if err != nil {
		return err
	}
	if err := os.WriteFile(strings.TrimSuffix(s.Path, ".yaml")+".yaml.bak", previous, 0o644); err != nil {
		return err
	}
	cursor := mark(ctx)
	if err := writeAtomic(s.Path, text); err != nil {
		return err
	}
	return s.verdict(ctx, cursor, string(previous))
}
