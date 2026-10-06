package setup

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestEveryMessageInBothLanguages(t *testing.T) {
	for key, m := range messages {
		if strings.TrimSpace(m[0]) == "" || strings.TrimSpace(m[1]) == "" {
			t.Errorf("%s: a language is empty: %q", key, m)
		}
		if strings.Count(m[0], "%") != strings.Count(m[1], "%") {
			t.Errorf("%s: the two languages take different arguments: %q", key, m)
		}
	}
}

// Every key the code names exists, so no screen shows a raw key.
func TestEveryKeyUsedExists(t *testing.T) {
	used := regexp.MustCompile(`Tf?\((?:l|p\.Lang|English|Chinese), "([a-z.]*[a-z])"[),]`)
	files, _ := os.ReadDir(".")
	for _, f := range files {
		if !strings.HasSuffix(f.Name(), ".go") || strings.HasSuffix(f.Name(), "_test.go") {
			continue
		}
		src, _ := os.ReadFile(f.Name())
		for _, m := range used.FindAllStringSubmatch(string(src), -1) {
			if _, ok := messages[m[1]]; !ok {
				t.Errorf("%s uses %q, which has no message", f.Name(), m[1])
			}
		}
	}
	for _, e := range EnginesFor([]string{"intel", "nvidia", "amd"}) {
		if _, ok := messages["engine."+e.Key]; !ok {
			t.Errorf("engine %s has no description", e.Key)
		}
	}
}

func TestParseLang(t *testing.T) {
	for in, want := range map[string]Lang{
		"en": English, "en_US.UTF-8": English, "zh-TW": Chinese, "zh_TW.UTF-8": Chinese,
		"zh_HK.UTF-8": Chinese, "zh": Chinese, "ja_JP.UTF-8": "", "": "", "C.UTF-8": "",
	} {
		if got := ParseLang(in); got != want {
			t.Errorf("ParseLang(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseLspci(t *testing.T) {
	out := `0000:00:02.0 VGA compatible controller [0300]: Intel Corporation Raptor Lake-S GT1 [UHD Graphics 770] [8086:a780] (rev 04)
0000:03:00.0 VGA compatible controller [0300]: ASPEED Technology, Inc. ASPEED Graphics Family [1a03:2000] (rev 52)
0000:0c:00.0 VGA compatible controller [0300]: Intel Corporation Device [8086:e223]
0000:41:00.0 3D controller [0302]: NVIDIA Corporation AD102 [GeForce RTX 4090] [10de:2684] (rev a1)
0000:41:00.1 Audio device [0403]: NVIDIA Corporation AD102 High Definition Audio Controller [10de:22ba] (rev a1)
`
	got := ParseLspci(out)
	want := []Card{
		{"0000:00:02.0", "intel", "Intel Corporation Raptor Lake-S GT1 [UHD Graphics 770]"},
		{"0000:0c:00.0", "intel", "Intel Corporation Device e223"},
		{"0000:41:00.0", "nvidia", "NVIDIA Corporation AD102 [GeForce RTX 4090]"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("card %d: got %+v, want %+v", i, got[i], want[i])
		}
	}
}

// The answers file is sourced by bash, so it is checked by bash.
func TestShellRoundTrip(t *testing.T) {
	a := Answers{Lang: Chinese, Root: "/home/o'brien/tenk stack", Engines: []string{"llamacpp", "vllm"},
		Comfy: []string{"0000:0c:00.0"}, SearXNG: true, TLS: "domain", Domain: "ai.example.com"}
	f := t.TempDir() + "/answers"
	os.WriteFile(f, []byte(a.Shell()), 0o600)
	out, err := exec.Command("bash", "-c", `set -u; . "$1"; printf '%s|%s|%s|%s|%s|%s|%s|%s|' "$UI_LANG" "$ACTION" "$ROOT" "$ENGINES" "$COMFY_CARDS" "$WANT_SEARXNG" "$TLS_MODE" "$DOMAIN"; if $PURGE; then echo purge; else echo keep; fi`, "_", f).Output()
	if err != nil {
		t.Fatal(err)
	}
	want := "zh-TW|install|/home/o'brien/tenk stack|llamacpp,vllm|0000:0c:00.0|y|domain|ai.example.com|keep\n"
	if string(out) != want {
		t.Errorf("got  %s\nwant %s", out, want)
	}
}

func TestEnginesFor(t *testing.T) {
	got := EnginesFor([]string{"intel"})
	if len(got) == 0 || got[0].Key != "llamacpp" || !got[0].Default {
		t.Fatalf("the default engine should come first: %+v", got)
	}
	keys := map[string]Engine{}
	for _, e := range got {
		keys[e.Key] = e
	}
	if _, ok := keys["vllm"]; !ok {
		t.Error("vLLM has an Intel build")
	}
	if e, ok := keys["sglang"]; !ok || !e.Verified {
		t.Error("SGLang has an Intel build, verified on a B70")
	}
	// A build never run on the hardware is shown as such.
	for _, e := range EnginesFor([]string{"nvidia"}) {
		if e.Key == "sglang" && e.Verified {
			t.Error("SGLang on NVIDIA is not verified")
		}
	}
	if len(EnginesFor(nil)) != 0 {
		t.Error("no vendor, no engine")
	}
}

// fakeConsole answers like the console's install endpoints: an engine
// takes two polls to register, ComfyUI two polls to start.
type fakeConsole struct {
	mu      sync.Mutex
	locked  bool
	macros  []string
	polls   map[string]int
	comfyOK bool
	actions []string
}

func (f *fakeConsole) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.locked {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	switch r.Method + " " + r.URL.Path {
	case "GET /api/providers":
		for macro, n := range f.polls {
			if strings.HasPrefix(macro, "engine:") {
				f.polls[macro] = n + 1
				if n+1 >= 2 {
					f.macros = append(f.macros, strings.TrimPrefix(macro, "engine:"))
					delete(f.polls, macro)
				}
			}
		}
		page := map[string]any{"providers": []any{}, "runtimes": []any{}}
		var rts []any
		for _, m := range f.macros {
			rts = append(rts, map[string]string{"macro": m})
		}
		page["runtimes"] = rts
		json.NewEncoder(w).Encode(page)
	case "POST /api/runtimes/action":
		var in map[string]string
		json.NewDecoder(r.Body).Decode(&in)
		f.actions = append(f.actions, in["provider"]+"/"+in["vendor"])
		macro := in["provider"] + "-" + in["vendor"]
		if in["provider"] == "llamacpp" {
			macro = "llama-" + in["vendor"]
		}
		f.polls["engine:"+macro] = 0
		w.Write([]byte(`{"state":"pulling"}`))
	case "POST /api/runtimes/card":
		var in map[string]any
		json.NewDecoder(r.Body).Decode(&in)
		if in["pci_bdf_address"] != "0000:0c:00.0" {
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"detail":"沒有這張卡"}`))
			return
		}
		f.polls["comfy"] = 0
		w.Write([]byte(`{"ok":true}`))
	case "GET /api/runtimes":
		n := f.polls["comfy"]
		f.polls["comfy"] = n + 1
		comfy := map[string]any{"container": nil, "job": map[string]any{"state": "pulling", "bytes_done": 1e9, "bytes_total": 4e9}}
		if n >= 1 {
			comfy = map[string]any{"container": "comfyui-xpu0", "job": nil}
		}
		json.NewEncoder(w).Encode([]any{map[string]any{"pci_bdf_address": "0000:0c:00.0", "comfy": comfy}})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func newProvisioner(t *testing.T, f *fakeConsole) (*Provisioner, *bytes.Buffer) {
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	var out bytes.Buffer
	return &Provisioner{Base: srv.URL, Client: srv.Client(), Out: &out, Lang: English,
		Poll: time.Millisecond, Timeout: 5 * time.Second}, &out
}

func TestProvisionEngine(t *testing.T) {
	f := &fakeConsole{polls: map[string]int{}, macros: []string{"llama-intel"}}
	p, out := newProvisioner(t, f)
	ctx := context.Background()
	if n, err := p.Engine(ctx, "llamacpp", []string{"intel"}); n != 0 || err != nil {
		t.Fatalf("llama.cpp: %d, %v", n, err)
	}
	if len(f.actions) != 0 || !strings.Contains(out.String(), "already installed") {
		t.Errorf("an installed engine is not installed again: %v\n%s", f.actions, out)
	}
	if n, err := p.Engine(ctx, "vllm", []string{"intel", "nvidia"}); n != 0 || err != nil {
		t.Fatalf("vLLM: %d, %v", n, err)
	}
	if strings.Join(f.actions, ",") != "vllm/intel,vllm/nvidia" {
		t.Errorf("one install per vendor with a build: %v", f.actions)
	}
	if !strings.Contains(out.String(), "vLLM for intel  done") {
		t.Errorf("output:\n%s", out)
	}
}

func TestProvisionComfy(t *testing.T) {
	f := &fakeConsole{polls: map[string]int{}}
	p, out := newProvisioner(t, f)
	ctx := context.Background()
	if ok, err := p.Comfy(ctx, "0000:0c:00.0"); !ok || err != nil {
		t.Fatalf("%v %v\n%s", ok, err, out)
	}
	if !strings.Contains(out.String(), "1.0 / 4.0 GB") || !strings.Contains(out.String(), "done") {
		t.Errorf("progress then done:\n%s", out)
	}
	out.Reset()
	if ok, err := p.Comfy(ctx, "0000:10:00.0"); ok || err != nil {
		t.Fatalf("a card the console cannot see: %v %v", ok, err)
	}
	if !strings.Contains(out.String(), "xpu-smi") {
		t.Errorf("says what to install:\n%s", out)
	}
}

func TestProvisionLocked(t *testing.T) {
	f := &fakeConsole{polls: map[string]int{}, locked: true}
	p, out := newProvisioner(t, f)
	_, err := p.Engine(context.Background(), "vllm", []string{"intel"})
	code, stop := p.stop(err)
	if !stop || code != ExitOK || !strings.Contains(out.String(), "Sign in") {
		t.Errorf("a console with accounts is reported, not failed: %d %v\n%s", code, stop, out)
	}
}

// PURGE and KEEP_IMAGES are run as commands by install.sh.
func TestShellUninstallFlags(t *testing.T) {
	a := Answers{Lang: English, Action: "uninstall", Root: "/srv/tenk", Purge: true, KeepImages: false}
	f := t.TempDir() + "/answers"
	os.WriteFile(f, []byte(a.Shell()), 0o600)
	out, err := exec.Command("bash", "-c", `set -eu; . "$1"; r="$ACTION"; if $PURGE; then r="$r purge"; fi; if $KEEP_IMAGES; then r="$r keep-images"; fi; echo "$r"`, "_", f).Output()
	if err != nil || strings.TrimSpace(string(out)) != "uninstall purge" {
		t.Fatalf("%q %v", out, err)
	}
}

func TestFacts(t *testing.T) {
	f := ParseFacts(`MISSING_PKGS="git docker caddy go"
MISSING_GROUPS="render"
NEEDS_REBOOT="false"
HAVE_SETCAP="false"
LINGER="true"
XPU_FILTER="false"
INTEL="true"
BUSY_PORTS="443 8090"
SEARXNG_PORT="8090"
CONSOLE_TLS_PORT="8443"
HOST="box"
`)
	if len(f.MissingPkgs) != 4 || f.Host != "box" || !f.Intel || f.Linger != true {
		t.Fatalf("parsed %+v", f)
	}
	if got := f.Busy(Answers{}); len(got) != 0 {
		t.Errorf("plain HTTP without SearXNG needs neither busy port: %v", got)
	}
	if got := f.Busy(Answers{TLS: "domain", SearXNG: true}); strings.Join(got, " ") != "443 8090" {
		t.Errorf("a domain needs 443, SearXNG its port: %v", got)
	}
	var texts []string
	for _, c := range f.Changes(English, Answers{TLS: "domain"}) {
		if strings.Contains(c.Text, "Caddy to ~/.local/bin") == c.Sudo {
			t.Errorf("only the Caddy download runs without sudo: %+v", c)
		}
		texts = append(texts, c.Text)
	}
	joined := strings.Join(texts, " | ")
	for _, want := range []string{"git, docker, libcap2-bin", "render", "setcap", "xpu-smi"} {
		if !strings.Contains(joined, want) {
			t.Errorf("changes lack %q: %s", want, joined)
		}
	}
	if strings.Contains(joined, "linger") {
		t.Errorf("linger is already on: %s", joined)
	}
}
