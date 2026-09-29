package setup

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// Protocol is how install.sh tells a binary that has these commands from
// one that does not, without running it: an older console given `setup`
// ignores the word and starts serving. install.sh greps the file for this.
const Protocol = "TENKSTACK_SETUP_PROTOCOL=1"

// Exit codes install.sh reads.
const (
	ExitOK        = 0
	ExitCancelled = 1
	ExitFailed    = 2
	// ExitNoTerminal: not run in a terminal, so install.sh asks its own
	// questions instead.
	ExitNoTerminal = 3
)

func isTerminal(f *os.File) bool {
	st, err := f.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}

func splitList(s string) []string {
	var out []string
	for _, v := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' }) {
		out = append(out, v)
	}
	return out
}

// MainSetup is `tenkstack setup`: the screens, then the answers written as
// shell assignments to --out. Flags carry what install.sh was already
// told, so the screens start from it.
func MainSetup(args []string) int {
	fs := flag.NewFlagSet("setup", flag.ContinueOnError)
	out := fs.String("out", "", "write the answers here (shell assignments)")
	lang := fs.String("lang", "", "en or zh-TW; asked first when not given")
	dir := fs.String("dir", "", "install directory")
	engines := fs.String("engines", "", "comma-separated engine keys to pre-select (default: the default engine)")
	comfy := fs.String("comfyui", "", "comma-separated PCI addresses to pre-select")
	searxng := fs.String("searxng", "", "y or n")
	tls := fs.String("tls", "", "internal or domain")
	domain := fs.String("domain", "", "public domain name")
	protocol := fs.Bool("protocol", false, "print the protocol install.sh checks for")
	if err := fs.Parse(args); err != nil {
		return ExitFailed
	}
	if *protocol {
		fmt.Println(Protocol)
		return ExitOK
	}
	if *out == "" {
		fmt.Fprintln(os.Stderr, "setup: --out is required")
		return ExitFailed
	}
	if !isTerminal(os.Stdin) || !isTerminal(os.Stdout) {
		return ExitNoTerminal
	}

	l := ParseLang(*lang)
	if l == "" {
		var err error
		if l, err = AskLanguage(""); err != nil {
			return exitFor(err, DefaultLang())
		}
	}
	m := Detect(context.Background())
	preset := Answers{Lang: l, Root: *dir, Engines: splitList(*engines), Comfy: splitList(*comfy),
		SearXNG: *searxng == "y", TLS: *tls, Domain: *domain}
	if *engines == "" {
		for _, e := range EnginesFor(m.Vendors()) {
			if e.Default {
				preset.Engines = []string{e.Key}
			}
		}
	}
	a, err := Ask(m, preset)
	if err != nil {
		return exitFor(err, l)
	}
	if err := os.WriteFile(*out, []byte(a.Shell()), 0o600); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return ExitFailed
	}
	return ExitOK
}

func exitFor(err error, l Lang) int {
	if errors.Is(err, ErrCancelled) {
		fmt.Println(T(l, "cancelled"))
		return ExitCancelled
	}
	fmt.Fprintln(os.Stderr, err)
	return ExitFailed
}

// MainProvision is `tenkstack provision`: install the chosen engines and
// ComfyUI instances through the running console. Anything that fails is
// reported and left for the console's pages; only an unreachable console
// is an error.
func MainProvision(args []string) int {
	fs := flag.NewFlagSet("provision", flag.ContinueOnError)
	api := fs.String("api", "http://127.0.0.1:8070", "the console's address")
	lang := fs.String("lang", "", "en or zh-TW")
	engines := fs.String("engines", "", "comma-separated engine keys")
	comfy := fs.String("comfyui", "", "comma-separated PCI addresses")
	vendors := fs.String("vendors", "", "comma-separated vendors (default: read from PCI)")
	timeout := fs.Duration("timeout", 90*time.Minute, "give up on one item after this long")
	if err := fs.Parse(args); err != nil {
		return ExitFailed
	}
	l := ParseLang(*lang)
	if l == "" {
		l = DefaultLang()
	}
	vs := splitList(*vendors)
	if len(vs) == 0 {
		vs = Detect(context.Background()).Vendors()
	}
	p := &Provisioner{Base: strings.TrimRight(*api, "/"), Client: &http.Client{Timeout: 30 * time.Second},
		Out: os.Stdout, Lang: l, Live: isTerminal(os.Stdout), Poll: 2 * time.Second, Timeout: *timeout}
	ctx := context.Background()

	failed := 0
	for _, key := range splitList(*engines) {
		n, err := p.Engine(ctx, key, vs)
		if code, stop := p.stop(err); stop {
			return code
		}
		failed += n
	}
	for _, address := range splitList(*comfy) {
		ok, err := p.Comfy(ctx, address)
		if code, stop := p.stop(err); stop {
			return code
		}
		if !ok {
			failed++
		}
	}
	if failed > 0 {
		fmt.Println("  " + T(l, "prov.later"))
	}
	return ExitOK
}

// stop decides whether an error ends the run: a locked console is said
// once and is not a failure of the install; anything else unreachable is.
func (p *Provisioner) stop(err error) (int, bool) {
	switch {
	case err == nil:
		return 0, false
	case errors.Is(err, ErrLocked):
		fmt.Fprintln(p.Out, "  "+T(p.Lang, "prov.locked"))
		return ExitOK, true
	default:
		fmt.Fprintln(p.Out, "  "+Tf(p.Lang, "prov.unreachable", p.Base)+" "+err.Error())
		return ExitFailed, true
	}
}
