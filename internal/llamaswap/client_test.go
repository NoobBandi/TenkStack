package llamaswap

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/NoobBandi/TenkStack/internal/api"
)

func TestParseFrameDoubleEncoded(t *testing.T) {
	ev, ok := parseFrame(`{"type":"logData","data":"{\"data\":\"hello\\n\"}"}`)
	if !ok || ev.Type != "logData" {
		t.Fatalf("frame not parsed: %+v", ev)
	}
	if text, _ := logText(ev); text != "hello\n" {
		t.Errorf("inner data = %q", text)
	}
	if _, ok := parseFrame(`{"data":"x"}`); ok {
		t.Error("frame without a type accepted")
	}
}

func TestExtractProgress(t *testing.T) {
	line := func(s string) api.Event { return api.Event{Type: "logData", Data: map[string]any{"data": s}} }

	p := ExtractProgress(line("print_timing: id  0 | task 12 | n_decoded = 100, tg = 20.50 t/s, tg_3s = 18.10 t/s"))
	if p == nil || p.Phase != "decode" || p.Slot != 0 || p.Task != 12 || p.Tokens != 100 || *p.Rate != 18.1 || *p.Average != 20.5 {
		t.Errorf("decode tick = %+v", p)
	}
	p = ExtractProgress(line("print_timing: id  1 | task 3 | prompt processing, n_tokens = 512, progress = 0.250000, t = 1.20 s / 426.67 tokens per second"))
	if p == nil || p.Phase != "prefill" || *p.Progress != 0.25 || *p.Elapsed != 1.2 || *p.Rate != 426.67 {
		t.Errorf("prefill tick = %+v", p)
	}
	p = ExtractProgress(line("slot      release: id  1 | task 3 | stop processing: n_tokens = 4096, truncated = 1"))
	if p == nil || p.Phase != "done" || p.Tokens != 4096 || !*p.Truncated {
		t.Errorf("release tick = %+v", p)
	}
	if ExtractProgress(line("nothing to see")) != nil {
		t.Error("a plain line produced a tick")
	}
}

func TestExtractThroughput(t *testing.T) {
	ev := api.Event{Type: "logData", Data: "       eval time =    5000.00 ms /   150 tokens (   33.33 ms per token,    30.00 tokens per second)"}
	tp := ExtractThroughput(ev)
	if tp == nil || tp.EvalMs != 5000 || tp.Tokens != 150 || tp.TokensPerSecond != 30 {
		t.Errorf("throughput = %+v", tp)
	}
}

func TestServedContext(t *testing.T) {
	serve := func(routes map[string]string) string {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body, ok := routes[r.URL.Path]
			if !ok {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write([]byte(body))
		}))
		t.Cleanup(srv.Close)
		return srv.URL
	}
	c := NewClient("")
	ctx := context.Background()
	cases := []struct {
		name   string
		routes map[string]string
		want   int
	}{
		// llama-server and Strata: the per-slot context in /props.
		{"props", map[string]string{"/props": `{"default_generation_settings":{"n_ctx":262144}}`}, 262144},
		// vLLM: no /props, max_model_len in /v1/models.
		{"vllm", map[string]string{"/v1/models": `{"data":[{"id":"m","max_model_len":131072}]}`}, 131072},
		// /props without a context falls through to /v1/models.
		{"props empty", map[string]string{
			"/props":     `{"build_info":"b1"}`,
			"/v1/models": `{"data":[{"id":"m","max_model_len":65536}]}`,
		}, 65536},
		{"neither", map[string]string{"/v1/models": `{"data":[{"id":"m"}]}`}, 0},
	}
	for _, tc := range cases {
		if got := c.ServedContext(ctx, serve(tc.routes)); got != tc.want {
			t.Errorf("%s: ServedContext = %d, want %d", tc.name, got, tc.want)
		}
	}
}
