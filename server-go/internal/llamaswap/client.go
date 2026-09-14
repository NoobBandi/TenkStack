package llamaswap

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
)

// Client reads llama-swap's state. Changing state is done by rewriting
// config.yaml and letting -watch-config pick it up; there is no management
// API for that and the file is the source of truth anyway.
type Client struct {
	Base string // http://127.0.0.1:8080
	http *http.Client
}

func NewClient(base string) *Client {
	return &Client{Base: base, http: &http.Client{Timeout: 5 * time.Second}}
}

func (c *Client) getJSON(ctx context.Context, base, path string, timeout time.Duration, v any) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("%s: HTTP %d", path, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

// Running is llama-swap's /running list, passed through as it arrives.
func (c *Client) Running(ctx context.Context) []map[string]any {
	var body struct {
		Running []map[string]any `json:"running"`
	}
	if err := c.getJSON(ctx, c.Base, "/running", 5*time.Second, &body); err != nil {
		log.Printf("llama-swap /running failed: %v", err)
		return nil
	}
	return body.Running
}

// Props is llama-server's own description of what it loaded; the
// authoritative answer for whether an mmproj was actually loaded.
func (c *Client) Props(ctx context.Context, proxy string) map[string]any {
	var props map[string]any
	if err := c.getJSON(ctx, proxy, "/props", 5*time.Second, &props); err != nil {
		return nil
	}
	return props
}

// Slots is how full each slot of a running model is. Only the counters are
// carried out: /slots also returns each slot's prompt text, which is
// somebody's whole conversation. Nil when the endpoint is unavailable.
func (c *Client) Slots(ctx context.Context, proxy string) []api.Slot {
	var raw []map[string]any
	if err := c.getJSON(ctx, proxy, "/slots", 5*time.Second, &raw); err != nil {
		return nil
	}
	slots := []api.Slot{}
	for _, slot := range raw {
		nctx, ok := slot["n_ctx"].(float64)
		if !ok || nctx <= 0 || nctx != float64(int(nctx)) {
			continue
		}
		used := 0
		if u, ok := slot["n_prompt_tokens"].(float64); ok && u >= 0 && u == float64(int(u)) {
			used = int(u)
		}
		busy, _ := slot["is_processing"].(bool)
		slots = append(slots, api.Slot{ID: slot["id"], NCtx: int(nctx), Used: used, Busy: busy})
	}
	return slots
}

func (c *Client) ListModels(ctx context.Context) []map[string]any {
	var body struct {
		Data []map[string]any `json:"data"`
	}
	if err := c.getJSON(ctx, c.Base, "/v1/models", 5*time.Second, &body); err != nil {
		log.Printf("llama-swap /v1/models failed: %v", err)
		return nil
	}
	return body.Data
}

// UnloadAll frees every resident model. llama-swap takes GET here.
func (c *Client) UnloadAll(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, c.Base+"/unload", nil)
	resp, err := c.http.Do(req)
	if err != nil {
		log.Printf("llama-swap /unload failed: %v", err)
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == 200
}

// UnloadModel frees one model and leaves the others resident.
func (c *Client) UnloadModel(ctx context.Context, modelID string) bool {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, c.Base+"/api/models/unload/"+modelID, nil)
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		log.Printf("llama-swap unload of %s failed: %v", modelID, err)
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == 200
}

// llama-server prints its timings to stderr, which llama-swap forwards as
// logData; that is the only place real throughput is reported.
var (
	evalTiming  = regexp.MustCompile(`eval time =\s*([\d.]+) ms /\s*(\d+) tokens.*?([\d.]+) tokens per second`)
	prefillTick = regexp.MustCompile(`print_timing: id\s+(\d+) \| task (\d+) \| prompt processing, n_tokens =\s*(\d+), progress = ([\d.]+), t =\s*([\d.]+) s / ([\d.]+) tokens per second`)
	decodeTick  = regexp.MustCompile(`print_timing: id\s+(\d+) \| task (\d+) \| (?:n_gen|n_decoded) =\s*(\d+), tg =\s*([\d.]+) t/s, tg_3s =\s*([\d.]+) t/s`)
	release     = regexp.MustCompile(`slot\s+release: id\s+(\d+) \| task (\d+) \| stop processing: n_tokens = (\d+), truncated = (\d+)`)
)

func logText(ev api.Event) (string, bool) {
	if ev.Type != "logData" {
		return "", false
	}
	switch d := ev.Data.(type) {
	case string:
		return d, true
	case map[string]any:
		s, ok := d["data"].(string)
		return s, ok
	}
	return "", false
}

func atoi(s string) int      { n, _ := strconv.Atoi(s); return n }
func atof(s string) float64  { f, _ := strconv.ParseFloat(s, 64); return f }
func fptr(s string) *float64 { f := atof(s); return &f }
func bptr(b bool) *bool      { return &b }

// ExtractThroughput pulls tokens/sec out of an upstream log frame.
func ExtractThroughput(ev api.Event) *api.Throughput {
	text, ok := logText(ev)
	if !ok {
		return nil
	}
	m := evalTiming.FindStringSubmatch(text)
	if m == nil {
		return nil
	}
	return &api.Throughput{EvalMs: atof(m[1]), Tokens: atoi(m[2]), TokensPerSecond: atof(m[3])}
}

// ExtractProgress is one tick of a request's lifecycle, or nil.
func ExtractProgress(ev api.Event) *api.ProgressTick {
	text, ok := logText(ev)
	if !ok {
		return nil
	}
	if m := decodeTick.FindStringSubmatch(text); m != nil {
		// tg_3s, not tg: the window is what shows a request slowing down.
		return &api.ProgressTick{Slot: atoi(m[1]), Task: atoi(m[2]), Phase: "decode",
			Tokens: atoi(m[3]), Rate: fptr(m[5]), Average: fptr(m[4])}
	}
	if m := prefillTick.FindStringSubmatch(text); m != nil {
		return &api.ProgressTick{Slot: atoi(m[1]), Task: atoi(m[2]), Phase: "prefill",
			Tokens: atoi(m[3]), Progress: fptr(m[4]), Elapsed: fptr(m[5]), Rate: fptr(m[6])}
	}
	if m := release.FindStringSubmatch(text); m != nil {
		// The whole window the request occupied, prompt included; truncated
		// means it ran into that ceiling mid-reply.
		return &api.ProgressTick{Slot: atoi(m[1]), Task: atoi(m[2]), Phase: "done",
			Tokens: atoi(m[3]), Truncated: bptr(m[4] != "0")}
	}
	return nil
}

// parseFrame unwraps one SSE payload. The outer object's data field is a
// JSON string parsed a second time; frames of another shape are dropped.
func parseFrame(payload string) (api.Event, bool) {
	var outer struct {
		Type string `json:"type"`
		Data any    `json:"data"`
	}
	if json.Unmarshal([]byte(payload), &outer) != nil || outer.Type == "" {
		return api.Event{}, false
	}
	if s, ok := outer.Data.(string); ok {
		var inner any
		if json.Unmarshal([]byte(s), &inner) == nil {
			outer.Data = inner
		}
	}
	return api.Event{Type: outer.Type, Data: outer.Data}, true
}

// How long after connecting llama-swap's scrollback keeps arriving. A
// replayed tick from an old request would draw a trace that never
// finishes, so anything inside this window is treated as history.
const replayWindow = time.Second

// Events yields llama-swap events until ctx ends, reconnecting with backoff
// when the stream drops. Throughput and progress ticks are emitted beside
// the raw frame they were read from.
func (c *Client) Events(ctx context.Context) <-chan api.Event {
	out := make(chan api.Event, 64)
	go func() {
		defer close(out)
		backoff := time.Second
		for {
			err := c.streamOnce(ctx, out)
			if ctx.Err() != nil {
				return
			}
			log.Printf("llama-swap event stream lost (%v); retrying in %s", err, backoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}()
	return out
}

func (c *Client) streamOnce(ctx context.Context, out chan<- api.Event) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Base+"/api/events", nil)
	if err != nil {
		return err
	}
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	opened := time.Now()
	send := func(ev api.Event) bool {
		select {
		case out <- ev:
			return true
		case <-ctx.Done():
			return false
		}
	}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	var data []string
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			if len(data) > 0 {
				if ev, ok := parseFrame(strings.Join(data, "\n")); ok {
					if time.Since(opened) > replayWindow {
						if t := ExtractThroughput(ev); t != nil && !send(api.Event{Type: "throughput", Data: t}) {
							return nil
						}
						if p := ExtractProgress(ev); p != nil && !send(api.Event{Type: "progress", Data: p}) {
							return nil
						}
					}
					if !send(ev) {
						return nil
					}
				}
				data = data[:0]
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	return fmt.Errorf("stream ended")
}
