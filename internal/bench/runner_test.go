package bench

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/NoobBandi/TenkStack/internal/api"
	"github.com/NoobBandi/TenkStack/internal/schema"
)

// fakeEngine is an OpenAI-compatible streaming server that counts a token
// per three runes, so calibration has something linear to find.
type fakeEngine struct {
	mu       sync.Mutex
	bodies   []map[string]any
	prompts  []int // prompt tokens of each streamed request
	loaded   bool
	natural  int           // tokens before a natural EOS when ignore_eos is not sent; 0: never
	perToken time.Duration // decode time per token
	prefill  time.Duration
	refuse   string // a field answered with a 400 when present
	inFlight int
	maxIn    int
	metrics  bool // serve vLLM speculative counters
	accepted float64
	drafted  float64
	timings  bool // send llama.cpp draft counts on the last chunk
	serial   bool // one request at a time, as Strata serves them
	one      sync.Mutex
}

func tokens(content string) int { return len([]rune(content))/3 + 12 }

func (f *fakeEngine) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if f.serial && strings.HasSuffix(r.URL.Path, "/chat/completions") {
		f.one.Lock()
		defer f.one.Unlock()
	}
	switch {
	case r.URL.Path == "/running":
		f.mu.Lock()
		loaded := f.loaded
		f.mu.Unlock()
		running := []map[string]string{}
		if loaded {
			running = append(running, map[string]string{"model": "m", "state": "ready"})
		}
		json.NewEncoder(w).Encode(map[string]any{"running": running})
		return
	case strings.HasPrefix(r.URL.Path, "/upstream/m/metrics"):
		if !f.metrics {
			http.NotFound(w, r)
			return
		}
		f.mu.Lock()
		fmt.Fprintf(w, "# HELP x\nvllm:spec_decode_num_accepted_tokens_total{engine=\"0\"} %g\nvllm:spec_decode_num_draft_tokens_total{engine=\"0\"} %g\n", f.accepted, f.drafted)
		f.mu.Unlock()
		return
	case r.URL.Path != "/v1/chat/completions":
		http.NotFound(w, r)
		return
	}
	var body map[string]any
	json.NewDecoder(r.Body).Decode(&body)
	if f.refuse != "" {
		if _, ok := body[f.refuse]; ok {
			http.Error(w, `{"error":{"message":"`+f.refuse+`: Input should be 'low', 'medium' or 'high'"}}`, http.StatusBadRequest)
			return
		}
	}
	f.mu.Lock()
	f.bodies = append(f.bodies, body)
	f.loaded = true
	f.mu.Unlock()
	content := body["messages"].([]any)[0].(map[string]any)["content"].(string)
	prompt := tokens(content)
	maxTokens := int(body["max_tokens"].(float64))
	if body["stream"] != true {
		json.NewEncoder(w).Encode(map[string]any{"usage": map[string]int{"prompt_tokens": prompt, "completion_tokens": 1}})
		return
	}
	f.mu.Lock()
	f.prompts = append(f.prompts, prompt)
	f.inFlight++
	f.maxIn = max(f.maxIn, f.inFlight)
	f.mu.Unlock()
	// Out of the count before [DONE] goes out, not when the handler
	// returns: the client starts its next request on [DONE], and counting
	// this one until its handler unwound saw five at once now and then.
	var once sync.Once
	leave := func() {
		once.Do(func() {
			f.mu.Lock()
			f.inFlight--
			f.mu.Unlock()
		})
	}
	defer leave()
	n := maxTokens
	if body["ignore_eos"] != true && f.natural > 0 {
		n = min(n, f.natural)
	}
	w.Header().Set("Content-Type", "text/event-stream")
	flusher := w.(http.Flusher)
	select {
	case <-time.After(f.prefill):
	case <-r.Context().Done():
		return
	}
	for i := 0; i < n; i++ {
		fmt.Fprintf(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"t\"}}]}\n\n")
		flusher.Flush()
		select {
		case <-time.After(f.perToken):
		case <-r.Context().Done():
			return
		}
	}
	last := map[string]any{"choices": []any{}, "usage": map[string]int{"prompt_tokens": prompt, "completion_tokens": n}}
	if f.timings {
		last["timings"] = map[string]int{"draft_n": 100, "draft_n_accepted": 40}
	}
	f.mu.Lock()
	f.accepted += 30
	f.drafted += 100
	f.mu.Unlock()
	b, _ := json.Marshal(last)
	leave()
	fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", b)
	flusher.Flush()
}

func newFake(t *testing.T, f *fakeEngine) (*Runner, *httptest.Server) {
	t.Helper()
	if f.perToken == 0 {
		f.perToken = 100 * time.Microsecond
	}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return &Runner{Base: srv.URL, Suite: SuiteV1(), RequestTimeout: 30 * time.Second, WarmupTimeout: 30 * time.Second}, srv
}

func describe(engine string, ctxLen int) Description {
	return Description{ModelID: "m", Name: "M", Command: "/home/x/run.sh --model /home/x/m.gguf",
		Engine: schema.EngineRef{Key: engine}, Tuning: schema.Tuning{ContextLength: ctxLen}}
}

func TestRunQuick(t *testing.T) {
	f := &fakeEngine{prefill: 2 * time.Millisecond, timings: true}
	r, _ := newFake(t, f)
	var steps []Step
	out, err := r.Run(context.Background(), describe("llamacpp", 0), Choice{Tier: api.BenchQuick}, func(s Step) { steps = append(steps, s) })
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, res := range out.Results {
		ids = append(ids, res.CaseID)
		if res.GenTPS <= 0 || res.TTFTMs <= 0 || res.PromptTPS <= 0 || res.Samples != max(1, map[string]int{"conc-4": 4}[res.CaseID]) {
			t.Errorf("%s: %+v", res.CaseID, res)
		}
		if !res.IgnoreEOS || res.OutputTokens != 256 {
			t.Errorf("%s: ignore_eos %v, output %v", res.CaseID, res.IgnoreEOS, res.OutputTokens)
		}
		if res.AcceptRate == nil || *res.AcceptRate != 0.4 {
			t.Errorf("%s: llama.cpp's draft counts give the accept rate: %v", res.CaseID, res.AcceptRate)
		}
	}
	if got := strings.Join(ids, ","); got != "depth-1k,conc-1,conc-4,content-zh,content-en,content-code" {
		t.Errorf("quick cases: %s", got)
	}
	if conc := out.Results[2]; conc.TotalGenTPS == nil || *conc.TotalGenTPS < conc.GenTPS*3 {
		t.Errorf("conc-4 total: %+v", conc)
	}
	if f.maxIn != 4 {
		t.Errorf("conc-4 sent %d at once, want 4", f.maxIn)
	}
	if out.ColdStartS == nil || out.Loaded {
		t.Errorf("not loaded at the start: cold start %v, loaded %v", out.ColdStartS, out.Loaded)
	}
	if len(steps) == 0 || steps[len(steps)-1].Done != 6 {
		t.Errorf("progress: %+v", steps)
	}

	// Calibrated depth: every measured request lands at 1k within a few
	// tokens; the warmup is the one without filler.
	for i, p := range f.prompts[1:] {
		if p < 1000 || p > 1050 {
			t.Errorf("request %d: %d prompt tokens, want about 1024", i+1, p)
		}
	}
	// One condition three times (depth-1k, conc-1, content-en) is measured
	// once: warmup + 1k + 4 streams + zh + code.
	if len(f.prompts) != 1+1+4+1+1 {
		t.Errorf("%d streamed requests", len(f.prompts))
	}

	seen := map[string]bool{}
	for _, b := range f.bodies {
		content := b["messages"].([]any)[0].(map[string]any)["content"].(string)
		head, _, _ := strings.Cut(content, "\n")
		if seen[head] {
			t.Errorf("prefix %s used twice", head)
		}
		seen[head] = true
		kw, _ := b["chat_template_kwargs"].(map[string]any)
		if kw["enable_thinking"] != false || b["reasoning_effort"] != "none" || b["temperature"] != 0.0 || b["seed"] != 0.0 {
			t.Errorf("fixed conditions missing: %v", b)
		}
		if b["stream"] == true {
			if b["ignore_eos"] != true || b["max_tokens"] != 256.0 {
				t.Errorf("llama.cpp is sent ignore_eos and 256 tokens: %v", b)
			}
			if so, _ := b["stream_options"].(map[string]any); so["include_usage"] != true {
				t.Errorf("usage not asked for: %v", b)
			}
		} else if b["max_tokens"] != 1.0 {
			t.Errorf("a probe asks for one token: %v", b)
		}
	}
}

// Strata takes no ignore_eos: it is not sent, and a reply that stops short
// of 80% of the target does not count.
func TestNoIgnoreEOSAndShortOutput(t *testing.T) {
	f := &fakeEngine{natural: 120, loaded: true}
	r, _ := newFake(t, f)
	out, err := r.Run(context.Background(), describe("strata", 0), Choice{Tier: api.BenchQuick}, nil)
	if err == nil || len(out.Results) != 0 {
		t.Fatalf("short replies only: %v, %+v", err, out.Results)
	}
	if !strings.Contains(err.Error(), "生成長度 120") {
		t.Errorf("error names the length: %v", err)
	}
	for _, b := range f.bodies {
		if _, ok := b["ignore_eos"]; ok {
			t.Fatalf("ignore_eos sent to strata: %v", b)
		}
	}
	if out.ColdStartS != nil {
		t.Errorf("loaded model has no cold start: %v", *out.ColdStartS)
	}

	f2 := &fakeEngine{natural: 230, loaded: true}
	r2, _ := newFake(t, f2)
	out, err = r2.Run(context.Background(), describe("strata", 0), Choice{Tier: api.BenchQuick}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res := out.Results[0]; res.IgnoreEOS || res.OutputTokens != 230 {
		t.Errorf("long enough natural reply counts as it is: %+v", res)
	}
}

// A field the engine refuses is left out from then on, not a failed run.
func TestRefusedFieldIsDropped(t *testing.T) {
	f := &fakeEngine{refuse: "reasoning_effort", loaded: true}
	r, _ := newFake(t, f)
	if _, err := r.Run(context.Background(), describe("vllm", 0), Choice{Tier: api.BenchQuick}, nil); err != nil {
		t.Fatal(err)
	}
	for _, b := range f.bodies {
		if _, ok := b["reasoning_effort"]; ok {
			t.Fatalf("refused field still sent: %v", b)
		}
	}
}

// vLLM's accept rate comes from its /metrics, read through llama-swap's
// upstream route before and after a case.
func TestAcceptRateFromMetrics(t *testing.T) {
	f := &fakeEngine{metrics: true, loaded: true}
	r, _ := newFake(t, f)
	out, err := r.Run(context.Background(), describe("vllm", 0), Choice{Tier: api.BenchQuick}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if a := out.Results[0].AcceptRate; a == nil || *a != 0.3 {
		t.Errorf("accept rate: %v", a)
	}
	f2 := &fakeEngine{loaded: true}
	r2, _ := newFake(t, f2)
	out, _ = r2.Run(context.Background(), describe("vllm", 0), Choice{Tier: api.BenchQuick}, nil)
	if out.Results[0].AcceptRate != nil {
		t.Errorf("no metrics, no accept rate")
	}
}

func TestFullRepeatsAndContextSkip(t *testing.T) {
	f := &fakeEngine{loaded: true}
	r, _ := newFake(t, f)
	out, err := r.Run(context.Background(), describe("llamacpp", 16384), Choice{Tier: api.BenchFull}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Skipped) != 3 || !strings.HasPrefix(out.Skipped[0], "depth-32k: ") {
		t.Errorf("skipped: %v", out.Skipped)
	}
	for _, res := range out.Results {
		want := 3
		if res.CaseID == "conc-2" {
			want = 6
		} else if res.CaseID == "conc-4" {
			want = 12
		}
		if res.Samples != want {
			t.Errorf("%s: %d samples, want %d", res.CaseID, res.Samples, want)
		}
	}
	var deep int
	for _, p := range f.prompts {
		if p > 7500 {
			deep++
			if p > 7680+80 {
				t.Errorf("8k request has %d tokens", p)
			}
		}
	}
	if deep != 3 {
		t.Errorf("%d requests at 8k, want 3", deep)
	}
}

func TestCancelStopsTheRun(t *testing.T) {
	f := &fakeEngine{loaded: true, perToken: 50 * time.Millisecond}
	r, _ := newFake(t, f)
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(200*time.Millisecond, cancel)
	start := time.Now()
	_, err := r.Run(ctx, describe("llamacpp", 0), Choice{Tier: api.BenchQuick}, nil)
	if err != context.Canceled {
		t.Errorf("err %v", err)
	}
	if time.Since(start) > 3*time.Second {
		t.Errorf("cancel took %s", time.Since(start))
	}
}

func TestSelectAndEstimate(t *testing.T) {
	s := SuiteV1()
	if len(s.Prompts) != 5 || s.OutputTokens != 256 || s.MinOutputRatio != 0.8 || s.Thinking || !s.UniquePrefix {
		t.Fatalf("suite: %+v", s)
	}
	quick, _ := Select(s, Choice{Tier: api.BenchQuick}, 0)
	full, _ := Select(s, Choice{Tier: api.BenchFull}, 0)
	if len(quick) != 6 || len(full) != 11 {
		t.Errorf("quick %d, full %d", len(quick), len(full))
	}
	per := 8192
	sliced := Description{Tuning: schema.Tuning{ContextLength: 65536, KVCache: &schema.KVCache{PerSlotContext: &per}}}
	if _, skipped := Select(s, Choice{Tier: api.BenchFull}, sliced.ContextLimit()); len(skipped) != 3 {
		t.Errorf("per-slot context decides: %v", skipped)
	}
	// What the engine reports beats the command: a 64K launch line on an
	// engine serving 128K per request runs everything.
	served := Description{Tuning: schema.Tuning{ContextLength: 65536}, ServedContext: 131072}
	if _, skipped := Select(s, Choice{Tier: api.BenchFull}, served.ContextLimit()); len(skipped) != 0 {
		t.Errorf("served 128k: skipped %v", skipped)
	}
	// Opened at exactly 64K, the 64k case fits and only 128k is left out.
	if _, skipped := Select(s, Choice{Tier: api.BenchFull}, Description{ServedContext: 65536}.ContextLimit()); len(skipped) != 1 {
		t.Errorf("served 64K: skipped %v, want depth-128k only", skipped)
	}
	if _, skipped := Select(s, Choice{Tier: api.BenchFull}, Description{ServedContext: 131072}.ContextLimit()); len(skipped) != 0 {
		t.Errorf("served 128K: skipped %v, want none", skipped)
	}
	q, fl := Estimate(s, Choice{Tier: api.BenchQuick}, quick, true), Estimate(s, Choice{Tier: api.BenchFull}, full, true)
	if q < 30 || q > 180 || fl < 4*60 || fl > 20*60 || Estimate(s, Choice{Tier: api.BenchQuick}, quick, false) <= q {
		t.Errorf("estimates: quick %d, full %d", q, fl)
	}
}

// A custom run measures what was picked plus the one-person 1k every
// comparison is against, once each or as the full tier repeats them.
func TestCustomChoice(t *testing.T) {
	s := SuiteV1()
	ids := func(cases []schema.BenchCase) []string {
		var out []string
		for _, c := range cases {
			out = append(out, c.ID)
		}
		return out
	}
	ch := Choice{Tier: api.BenchCustom, Cases: []string{"depth-32k", "conc-2", "content-zh"}, Repeats: 1}
	if err := ch.Check(s); err != nil {
		t.Fatal(err)
	}
	cases, _ := Select(s, ch, 0)
	if got := ids(cases); !slices.Equal(got, []string{"depth-1k", "depth-32k", "conc-1", "conc-2", "content-zh", "content-en"}) {
		t.Errorf("cases %v", got)
	}
	if repeatsFor(cases[1], ch) != 1 || repeatsFor(cases[1], Choice{Tier: api.BenchCustom}) != 3 {
		t.Error("repeats: 1 is once, 0 is as the suite says")
	}
	// Nothing picked still measures the base, under its three names.
	if base, _ := Select(s, Choice{Tier: api.BenchCustom}, 0); !slices.Equal(ids(base), []string{"depth-1k", "conc-1", "content-en"}) {
		t.Errorf("base only: %v", ids(base))
	}
	for _, bad := range []Choice{
		{Tier: "fast"},
		{Tier: api.BenchCustom, Cases: []string{"depth-2k"}},
		{Tier: api.BenchCustom, Repeats: 5},
	} {
		if bad.Check(s) == nil {
			t.Errorf("%+v passed", bad)
		}
	}
	if !ch.Same(Choice{Tier: api.BenchCustom, Cases: []string{"content-zh", "conc-2", "depth-32k"}, Repeats: 1}) ||
		ch.Same(Choice{Tier: api.BenchCustom, Cases: ch.Cases}) || !(Choice{Tier: api.BenchQuick}).Same(Choice{Tier: api.BenchQuick}) {
		t.Error("Same")
	}
	if Estimate(s, ch, cases, true) >= Estimate(s, Choice{Tier: api.BenchCustom, Cases: ch.Cases}, cases, true) {
		t.Error("once each is quicker than three times")
	}
}

func TestCut(t *testing.T) {
	if got := cut("abc", 8); got != "abc\n\nabc" {
		t.Errorf("%q", got)
	}
	if got := cut("台北市", 4); got != "台北市\n" {
		t.Errorf("%q", got)
	}
}

func TestPromSum(t *testing.T) {
	text := "vllm:spec_decode_num_draft_tokens_total{engine=\"0\",model_name=\"m\"} 10\n" +
		"vllm:spec_decode_num_draft_tokens_total{engine=\"1\",model_name=\"m\"} 5.5\n" +
		"vllm:spec_decode_num_draft_tokens_created 1.7e9\n"
	if v, ok := promSum(text, "vllm:spec_decode_num_draft_tokens_total"); !ok || v != 15.5 {
		t.Errorf("%v %v", v, ok)
	}
	if _, ok := promSum(text, "vllm:spec_decode_num_accepted_tokens_total"); ok {
		t.Error("absent metric found")
	}
}

// An engine that serves one request at a time decodes each of conc-4's
// streams at full speed in turn; its total is one stream's rate, not four.
func TestSerialEngineTotal(t *testing.T) {
	f := &fakeEngine{loaded: true, serial: true, perToken: 200 * time.Microsecond}
	r, _ := newFake(t, f)
	out, err := r.Run(context.Background(), describe("strata", 0), Choice{Tier: api.BenchQuick}, func(Step) {})
	if err != nil {
		t.Fatal(err)
	}
	for _, res := range out.Results {
		if res.CaseID != "conc-4" {
			continue
		}
		if res.TotalGenTPS == nil || *res.TotalGenTPS > res.GenTPS*1.3 {
			t.Errorf("serial conc-4: per stream %.1f, total %v; want about one stream's", res.GenTPS, res.TotalGenTPS)
		}
		return
	}
	t.Fatal("no conc-4 result")
}
