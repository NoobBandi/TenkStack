// Package channels controls which ways in are open and from which
// networks. Each optional channel is one Caddy site block in its own file:
// in channels/ when on, channels/disabled/ when off. Reach is a bind
// directive generated into channels/binds/<name>.bind, which is an actual
// boundary: a channel restricted to the LAN has nothing listening on the
// Tailscale address at all.
package channels

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
)

const loopback = "127.0.0.1"

var Scopes = []string{"lan", "tailscale", "wan"}

type meta struct {
	key, label string
	port       int
	encrypted  bool
	note       string
}

type Channels struct {
	Dir        string // the caddy directory
	CaddyBin   string
	APIPort    int
	ComfyBase  int // the first upstream ComfyUI port
	PublicBase int // where the first instance is published
}

func (c *Channels) caddyfile() string { return filepath.Join(c.Dir, "Caddyfile") }
func (c *Channels) channels() string  { return filepath.Join(c.Dir, "channels") }
func (c *Channels) disabled() string  { return filepath.Join(c.channels(), "disabled") }
func (c *Channels) binds() string     { return filepath.Join(c.channels(), "binds") }

func (c *Channels) metas() []meta {
	return []meta{
		{"api-http", "API（純 HTTP）", c.APIPort, false,
			"給不方便信任自簽憑證的用戶端，例如 Opencode。只開放 /v1，API key 在區網上是明文傳送。"},
		{"comfyui", "ComfyUI", c.PublicBase, true, "圖像生成介面，經主控台登入驗證後才放行。"},
	}
}

func (c *Channels) known(name string) bool {
	for _, m := range c.metas() {
		if m.key == name {
			return true
		}
	}
	return false
}

// Addresses is the address behind each scope right now. LAN is taken from
// the interface carrying the default route.
func Addresses() map[string]*string {
	out := map[string]*string{"lan": nil, "tailscale": nil, "wan": strp("0.0.0.0")}
	run := func(args ...string) string {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		b, _ := exec.CommandContext(ctx, "ip", args...).Output()
		return string(b)
	}
	defaultIface := ""
	route := strings.Fields(run("-4", "route", "show", "default"))
	for i, f := range route {
		if f == "dev" && i+1 < len(route) {
			defaultIface = route[i+1]
		}
	}
	for _, line := range strings.Split(run("-4", "-o", "addr", "show"), "\n") {
		parts := strings.Fields(line)
		if len(parts) < 4 {
			continue
		}
		iface, address := parts[1], strings.SplitN(parts[3], "/", 2)[0]
		if strings.HasPrefix(iface, "tailscale") {
			out["tailscale"] = strp(address)
		} else if defaultIface != "" && iface == defaultIface {
			out["lan"] = strp(address)
		}
	}
	return out
}

func strp(s string) *string { return &s }

func (c *Channels) bindPath(name string) string { return filepath.Join(c.binds(), name+".bind") }

// readScopes is what the bind file expresses. A missing or empty file is
// Caddy's default of listening everywhere, reported as wan.
func (c *Channels) readScopes(name string, addresses map[string]*string) []string {
	b, err := os.ReadFile(c.bindPath(name))
	text := strings.TrimSpace(string(b))
	if err != nil || text == "" {
		return []string{"wan"}
	}
	listed := map[string]bool{}
	if strings.HasPrefix(text, "bind") {
		for _, a := range strings.Fields(text)[1:] {
			listed[a] = true
		}
	}
	if listed["0.0.0.0"] {
		return []string{"wan"}
	}
	scopes := []string{}
	for _, scope := range []string{"lan", "tailscale"} {
		if a := addresses[scope]; a != nil && listed[*a] {
			scopes = append(scopes, scope)
		}
	}
	return scopes
}

func (c *Channels) writeScopes(name string, scopes map[string]bool) error {
	if err := os.MkdirAll(c.binds(), 0o755); err != nil {
		return err
	}
	if scopes["wan"] {
		return os.WriteFile(c.bindPath(name), []byte("bind 0.0.0.0\n"), 0o644)
	}
	current := Addresses()
	// Loopback always: the host must reach its own services.
	listed := []string{loopback}
	for _, scope := range []string{"lan", "tailscale"} {
		if scopes[scope] && current[scope] != nil {
			listed = append(listed, *current[scope])
		}
	}
	return os.WriteFile(c.bindPath(name), []byte("bind "+strings.Join(listed, " ")+"\n"), 0o644)
}

var (
	// A site address line, anchored to the line start so ports inside a
	// reverse_proxy directive or prose are not mistaken for published ones.
	addressLine = regexp.MustCompile(`^\s*https?://\S`)
	portIn      = regexp.MustCompile(`:(\d+)`)
)

// published reads the ports a channel file actually opens.
func published(path string) []int {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	found := map[int]bool{}
	for _, line := range strings.Split(string(b), "\n") {
		if addressLine.MatchString(line) {
			for _, m := range portIn.FindAllStringSubmatch(line, -1) {
				n, _ := strconv.Atoi(m[1])
				found[n] = true
			}
		}
	}
	out := make([]int, 0, len(found))
	for p := range found {
		out = append(out, p)
	}
	sort.Ints(out)
	return out
}

// file finds a channel's file in either directory.
func (c *Channels) file(name string) string {
	for _, dir := range []string{c.channels(), c.disabled()} {
		p := filepath.Join(dir, name+".caddy")
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

func (c *Channels) Status() api.Channels {
	addresses := Addresses()
	out := api.Channels{Channels: []api.Channel{}, Addresses: addresses}
	for _, m := range c.metas() {
		path := c.file(m.key)
		ports := published(path)
		if len(ports) == 0 {
			ports = []int{}
			if m.port != 0 {
				ports = []int{m.port}
			}
		}
		out.Channels = append(out.Channels, api.Channel{
			Key: m.key, Enabled: path != "" && filepath.Dir(path) == c.channels(), Present: path != "",
			Scopes: c.readScopes(m.key, addresses), Ports: ports,
			Label: m.label, Port: m.port, Encrypted: m.encrypted, Note: m.note,
		})
	}
	return out
}

func run(ctx context.Context, timeout time.Duration, name string, args ...string) (int, string) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return 1, name + " timed out"
	}
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return exit.ExitCode(), string(out)
		}
		return 1, err.Error()
	}
	return 0, string(out)
}

func tail(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return s[len(s)-n:]
	}
	return s
}

// ApplyError is a change Caddy refused; the files have been put back.
type ApplyError struct{ Msg string }

func (e *ApplyError) Error() string { return e.Msg }

// apply validates, reloads, and undoes the change if either step fails.
// Reload rather than restart: this is the gateway, and toggling who may
// reach what must not drop the SSE stream or a ComfyUI job's websocket.
func (c *Channels) apply(ctx context.Context, rollback func()) error {
	if code, out := run(ctx, 60*time.Second, c.CaddyBin, "validate", "--config", c.caddyfile(), "--adapter", "caddyfile"); code != 0 {
		rollback()
		log.Printf("caddy validate rejected the change: %s", tail(out, 400))
		return &ApplyError{"設定驗證失敗，已還原：" + tail(out, 200)}
	}
	if code, out := run(ctx, 60*time.Second, "systemctl", "--user", "reload", "caddy"); code != 0 {
		rollback()
		if code, _ := run(ctx, 60*time.Second, "systemctl", "--user", "reload", "caddy"); code != 0 {
			run(ctx, 60*time.Second, "systemctl", "--user", "restart", "caddy")
		}
		return &ApplyError{"Caddy 重新載入失敗，已還原：" + tail(out, 200)}
	}
	return nil
}

var (
	ErrUnknown = errors.New("no such channel")
	ErrMissing = errors.New("channel file is missing")
)

func (c *Channels) SetEnabled(ctx context.Context, name string, enabled bool) (api.Channels, error) {
	if !c.known(name) {
		return api.Channels{}, ErrUnknown
	}
	path := c.file(name)
	if path == "" {
		return api.Channels{}, fmt.Errorf("%w: %s.caddy is missing from %s", ErrMissing, name, c.channels())
	}
	target := c.channels()
	if !enabled {
		target = c.disabled()
	}
	if filepath.Dir(path) == target {
		st := c.Status()
		st.Changed = boolp(false)
		return st, nil
	}
	if err := os.MkdirAll(c.disabled(), 0o755); err != nil {
		return api.Channels{}, err
	}
	dest := filepath.Join(target, filepath.Base(path))
	if err := os.Rename(path, dest); err != nil {
		return api.Channels{}, err
	}
	if err := c.apply(ctx, func() { os.Rename(dest, path) }); err != nil {
		return api.Channels{}, err
	}
	log.Printf("channel %s enabled=%v", name, enabled)
	st := c.Status()
	st.Changed = boolp(true)
	return st, nil
}

func boolp(b bool) *bool { return &b }

func (c *Channels) SetScopes(ctx context.Context, name string, scopes []string) (api.Channels, error) {
	if !c.known(name) {
		return api.Channels{}, ErrUnknown
	}
	wanted := map[string]bool{}
	for _, s := range scopes {
		for _, known := range Scopes {
			if s == known {
				wanted[s] = true
			}
		}
	}
	path := c.bindPath(name)
	previous, err := os.ReadFile(path)
	had := err == nil
	rollback := func() {
		if had {
			os.WriteFile(path, previous, 0o644)
		} else {
			os.Remove(path)
		}
	}
	if err := c.writeScopes(name, wanted); err != nil {
		return api.Channels{}, err
	}
	if err := c.apply(ctx, rollback); err != nil {
		return api.Channels{}, err
	}
	st := c.Status()
	st.Changed = boolp(true)
	return st, nil
}

// Publishing one ComfyUI instance: a site block per instance, mapped by a
// fixed offset from its upstream port. Hosts are copied from a block that
// already exists, since that list is the machine's own answer to what it
// is called.
const comfyChannel = "comfyui.caddy"

var (
	siteBlock = regexp.MustCompile(`\n#[^\n]*\n(?:https://[^\n]*\n)*[^\n]*\{\n\timport comfyui-channel (\d+)\n\}\n`)
	hostIn    = regexp.MustCompile(`https://([^:,\s]+):\d+`)
)

func (c *Channels) PublicPort(upstream int) int { return c.PublicBase + (upstream - c.ComfyBase) }

func (c *Channels) comfyPath() string {
	for _, dir := range []string{c.channels(), c.disabled()} {
		p := filepath.Join(dir, comfyChannel)
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

func hosts(text string) []string {
	var found []string
	seen := map[string]bool{}
	for _, m := range hostIn.FindAllStringSubmatch(text, -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			found = append(found, m[1])
		}
	}
	if len(found) > 0 {
		return found
	}
	name, _ := os.Hostname()
	names := []string{"localhost", "127.0.0.1", name}
	addresses := Addresses()
	for _, key := range []string{"lan", "tailscale"} {
		if a := addresses[key]; a != nil {
			names = append(names, *a)
		}
	}
	seen = map[string]bool{}
	found = found[:0]
	for _, n := range names {
		if !seen[n] {
			seen[n] = true
			found = append(found, n)
		}
	}
	return found
}

// PublishComfy adds a site block for one instance and reloads; returns the
// public port.
func (c *Channels) PublishComfy(ctx context.Context, upstream int, note string) (int, error) {
	path := c.comfyPath()
	if path == "" {
		return 0, &ApplyError{"找不到 " + comfyChannel + "，無法發布這個實例"}
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	text := string(b)
	if strings.Contains(text, fmt.Sprintf("import comfyui-channel %d\n", upstream)) {
		return c.PublicPort(upstream), nil
	}
	port := c.PublicPort(upstream)
	var addresses []string
	for _, h := range hosts(text) {
		addresses = append(addresses, fmt.Sprintf("https://%s:%d", h, port))
	}
	header := fmt.Sprintf("\n# :%d", upstream)
	if note != "" {
		header += " -- " + note
	}
	block := header + "\n" + strings.Join(addresses, ",\n") + fmt.Sprintf(" {\n\timport comfyui-channel %d\n}\n", upstream)
	if err := os.WriteFile(path, []byte(strings.TrimRight(text, "\n")+"\n"+block), 0o644); err != nil {
		return 0, err
	}
	if err := c.apply(ctx, func() { os.WriteFile(path, b, 0o644) }); err != nil {
		return 0, err
	}
	log.Printf("published ComfyUI :%d on :%d", upstream, port)
	return port, nil
}

// UnpublishComfy removes one instance's site block and reloads.
func (c *Channels) UnpublishComfy(ctx context.Context, upstream int) error {
	path := c.comfyPath()
	if path == "" {
		return nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	text := string(b)
	trimmed := siteBlock.ReplaceAllStringFunc(text, func(m string) string {
		if siteBlock.FindStringSubmatch(m)[1] == strconv.Itoa(upstream) {
			return ""
		}
		return m
	})
	if trimmed == text {
		return nil
	}
	if err := os.WriteFile(path, []byte(trimmed), 0o644); err != nil {
		return err
	}
	if err := c.apply(ctx, func() { os.WriteFile(path, b, 0o644) }); err != nil {
		return err
	}
	log.Printf("unpublished ComfyUI :%d", upstream)
	return nil
}
