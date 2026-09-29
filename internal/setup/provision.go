package setup

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/NoobBandi/TenkStack/internal/providers"
)

// Provisioner installs engines and ComfyUI instances through a running
// console's own endpoints, the ones its Engines and ComfyUI pages use. It
// can only do so before the first account exists: until then the console
// has no authentication, and after it this reports that it is locked out
// rather than trying to be clever.
type Provisioner struct {
	Base   string // http://127.0.0.1:8070
	Client *http.Client
	Out    io.Writer
	Lang   Lang
	// Live: rewrite one progress line in place (a terminal); otherwise
	// print a line whenever the state changes.
	Live    bool
	Poll    time.Duration
	Timeout time.Duration
}

// ErrLocked is a console that already has accounts.
var ErrLocked = errors.New("console requires sign-in")

type apiError struct {
	Status int
	Detail string
}

func (e *apiError) Error() string { return fmt.Sprintf("HTTP %d: %s", e.Status, e.Detail) }

func (p *Provisioner) call(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		raw, _ := json.Marshal(in)
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, p.Base+path, body)
	if err != nil {
		return err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := p.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return ErrLocked
	}
	if resp.StatusCode >= 300 {
		var e struct {
			Detail string `json:"detail"`
		}
		json.Unmarshal(raw, &e)
		if e.Detail == "" {
			e.Detail = strings.TrimSpace(string(raw))
		}
		return &apiError{resp.StatusCode, e.Detail}
	}
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
}

type progress struct {
	State      string `json:"state"`
	BytesDone  int64  `json:"bytes_done"`
	BytesTotal int64  `json:"bytes_total"`
	Message    string `json:"message"`
}

type providersPage struct {
	Providers []struct {
		Key    string `json:"key"`
		Builds []struct {
			Vendor string `json:"vendor"`
			State  struct {
				Install *progress `json:"install"`
			} `json:"state"`
		} `json:"builds"`
	} `json:"providers"`
	Runtimes []struct {
		Macro string `json:"macro"`
	} `json:"runtimes"`
}

type runtimeRow struct {
	Address *string `json:"pci_bdf_address"`
	Comfy   *struct {
		Container *string   `json:"container"`
		Job       *progress `json:"job"`
	} `json:"comfy"`
}

// line reports one item's state, in place when live.
func (p *Provisioner) line(label, state string, pr *progress, final bool) {
	text := fmt.Sprintf("  %s  %s", label, state)
	if pr != nil && pr.BytesTotal > 0 {
		text += fmt.Sprintf("  %.1f / %.1f GB", float64(pr.BytesDone)/1e9, float64(pr.BytesTotal)/1e9)
	}
	if p.Live {
		fmt.Fprintf(p.Out, "\r\033[K%s", text)
		if final {
			fmt.Fprintln(p.Out)
		}
		return
	}
	fmt.Fprintln(p.Out, text)
}

func (p *Provisioner) stateWord(s string) string {
	switch s {
	case "pulling":
		return T(p.Lang, "prov.pulling")
	case "writing":
		return T(p.Lang, "prov.writing")
	case "starting":
		return T(p.Lang, "prov.starting")
	}
	return s
}

// Engine installs one engine for each of the vendors it has a build for.
// Failures are reported and counted, not fatal: the rest still installs.
func (p *Provisioner) Engine(ctx context.Context, key string, vendors []string) (failed int, err error) {
	prov := providers.Get(key)
	if prov == nil {
		p.line(key, Tf(p.Lang, "prov.failed", Tf(p.Lang, "prov.unknown", key)), nil, true)
		return 1, nil
	}
	for _, vendor := range vendors {
		if _, ok := prov.Builds[vendor]; !ok {
			continue
		}
		label := Tf(p.Lang, "prov.engine", prov.Name, vendor)
		macro := prov.Macro(vendor)
		var page providersPage
		if err := p.call(ctx, "GET", "/api/providers", nil, &page); err != nil {
			return failed, err
		}
		if hasMacro(page, macro) {
			p.line(label, T(p.Lang, "prov.already"), nil, true)
			continue
		}
		err := p.call(ctx, "POST", "/api/runtimes/action",
			map[string]string{"provider": key, "vendor": vendor, "action": "install"}, nil)
		if errors.Is(err, ErrLocked) {
			return failed, err
		}
		if err != nil {
			p.line(label, Tf(p.Lang, "prov.failed", detail(err)), nil, true)
			failed++
			continue
		}
		ok, msg := p.waitEngine(ctx, key, vendor, macro, label)
		if !ok {
			p.line(label, msg, nil, true)
			failed++
		}
	}
	return failed, nil
}

func hasMacro(page providersPage, macro string) bool {
	for _, r := range page.Runtimes {
		if r.Macro == macro {
			return true
		}
	}
	return false
}

func detail(err error) string {
	var e *apiError
	if errors.As(err, &e) {
		return e.Detail
	}
	return err.Error()
}

// waitEngine follows an install until its launcher is registered. The
// progress is on the engine's build only when the console can see a card
// of that vendor; without one it still finishes, just without a bar.
func (p *Provisioner) waitEngine(ctx context.Context, key, vendor, macro, label string) (bool, string) {
	deadline := time.Now().Add(p.Timeout)
	for time.Now().Before(deadline) {
		var page providersPage
		if err := p.call(ctx, "GET", "/api/providers", nil, &page); err == nil {
			if hasMacro(page, macro) {
				p.line(label, T(p.Lang, "prov.done"), nil, true)
				return true, ""
			}
			for _, c := range page.Providers {
				if c.Key != key {
					continue
				}
				for _, b := range c.Builds {
					if b.Vendor != vendor || b.State.Install == nil {
						continue
					}
					in := b.State.Install
					if in.State == "error" {
						return false, Tf(p.Lang, "prov.failed", in.Message)
					}
					p.line(label, p.stateWord(in.State), in, false)
				}
			}
		}
		select {
		case <-ctx.Done():
			return false, ctx.Err().Error()
		case <-time.After(p.Poll):
		}
	}
	return false, Tf(p.Lang, "prov.timeout", p.Timeout)
}

// Comfy creates a ComfyUI instance on one card and follows it until the
// container exists.
func (p *Provisioner) Comfy(ctx context.Context, address string) (ok bool, err error) {
	label := Tf(p.Lang, "prov.comfy", address)
	err = p.call(ctx, "POST", "/api/runtimes/card",
		map[string]any{"pci_bdf_address": address, "capability": "images", "on": true}, nil)
	if errors.Is(err, ErrLocked) {
		return false, err
	}
	var e *apiError
	if errors.As(err, &e) && e.Status == http.StatusNotFound {
		p.line(label, T(p.Lang, "prov.nocard"), nil, true)
		return false, nil
	}
	if err != nil {
		p.line(label, Tf(p.Lang, "prov.failed", detail(err)), nil, true)
		return false, nil
	}
	deadline := time.Now().Add(p.Timeout)
	for time.Now().Before(deadline) {
		var rows []runtimeRow
		if err := p.call(ctx, "GET", "/api/runtimes", nil, &rows); err == nil {
			for _, r := range rows {
				if r.Address == nil || !sameCard(*r.Address, address) || r.Comfy == nil {
					continue
				}
				job := r.Comfy.Job
				switch {
				case job != nil && job.State == "error":
					p.line(label, Tf(p.Lang, "prov.failed", job.Message), nil, true)
					return false, nil
				case job != nil && job.State != "done":
					p.line(label, p.stateWord(job.State), job, false)
				case r.Comfy.Container != nil:
					p.line(label, T(p.Lang, "prov.done"), nil, true)
					return true, nil
				}
			}
		}
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-time.After(p.Poll):
		}
	}
	p.line(label, Tf(p.Lang, "prov.timeout", p.Timeout), nil, true)
	return false, nil
}

// sameCard compares PCI addresses the way the console does, ignoring the
// domain's case and a missing 0000: prefix.
func sameCard(a, b string) bool {
	norm := func(s string) string {
		s = strings.ToLower(s)
		if strings.Count(s, ":") == 1 {
			s = "0000:" + s
		}
		return s
	}
	return norm(a) == norm(b)
}
