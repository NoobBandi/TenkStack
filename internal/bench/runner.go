package bench

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/NoobBandi/TenkStack/internal/schema"
)

// Runner measures one model the way §7.3 says, the same for every engine
// (D22): OpenAI streaming chat completions, timed from this side, with the
// engine's own token counts. It talks to llama-swap directly rather than
// through the console's /v1, which is paused while it runs (D27).
type Runner struct {
	Base   string       // llama-swap, http://127.0.0.1:8080
	Client *http.Client // nil: one without an overall timeout; each request has its own
	Suite  schema.BenchSuite

	// RequestTimeout bounds one measured request, WarmupTimeout the first
	// one, which may have to load the model: llama-swap gives a load up to
	// its healthCheckTimeout (900 s here) before it gives up.
	RequestTimeout time.Duration
	WarmupTimeout  time.Duration
}

const (
	defaultRequestTimeout = 10 * time.Minute
	defaultWarmupTimeout  = 20 * time.Minute
	probeTimeout          = 5 * time.Minute
)

// Step is one moment of a run, for the progress the UI shows.
type Step struct {
	Case    string
	Done    int
	Total   int
	Message string
	Results []schema.CaseResult
	Skipped []string
}

// Outcome is what the runner measured. Cases that failed or produced no
// valid sample are in Skipped, not in Results.
type Outcome struct {
	Results    []schema.CaseResult
	Skipped    []string
	ColdStartS *float64
	Loaded     bool // the model was resident when the run began
}

// ignoreEOSEngines take ignore_eos (D24). Strata does not; it is given
// prompts that ask for long output, and short replies do not count.
var ignoreEOSEngines = map[string]bool{"llamacpp": true, "vllm": true, "sglang": true}

// droppable are request fields an engine may refuse outright. A 400 that
// names one drops it for the rest of the run instead of failing the run:
// reasoning_effort "none" is newer than some engines' validation.
var droppable = []string{"reasoning_effort", "ignore_eos", "seed", "chat_template_kwargs", "stream_options"}

// run is one Run's state.
type run struct {
	r    *Runner
	desc Description

	mu      sync.Mutex
	dropped map[string]bool
	base    map[string]int     // prompt ref + filler language -> prompt tokens with no filler
	rate    map[string]float64 // filler language -> tokens per rune of filler
}

// Run warms the model up and measures every case of the tier. It stops
// at the first error that is not one case's own.
func (r *Runner) Run(ctx context.Context, desc Description, tier string, report func(Step)) (Outcome, error) {
	if report == nil {
		report = func(Step) {}
	}
	cases, skipped := Select(r.Suite, tier, desc.ContextLimit())
	out := Outcome{Results: []schema.CaseResult{}, Skipped: skipped}
	if len(cases) == 0 {
		return out, errors.New("這個檔次沒有能跑的項目（上下文長度不夠）")
	}
	ru := &run{r: r, desc: desc, dropped: map[string]bool{}, base: map[string]int{}, rate: map[string]float64{}}
	step := func(s Step) {
		s.Total = len(cases)
		s.Results = append([]schema.CaseResult(nil), out.Results...)
		s.Skipped = append([]string(nil), out.Skipped...)
		report(s)
	}

	out.Loaded = r.Loaded(ctx, desc.ModelID)
	if out.Loaded {
		step(Step{Message: "預熱中"})
	} else {
		step(Step{Message: "載入模型並預熱中，大模型可能要幾分鐘"})
	}
	// At least one warmup even if a suite asks for none: it is what loads
	// the model, and a load must not land inside a measurement.
	warmText := compose(headerFor("en"), "", r.Suite.Prompts["en"])
	for i := 0; i < max(r.Suite.Warmup, 1); i++ {
		s, err := ru.send(ctx, r.warmupTimeout(), prefix()+warmText, r.Suite.OutputTokens)
		if err != nil {
			if ctx.Err() != nil {
				return out, ctx.Err()
			}
			return out, fmt.Errorf("預熱失敗：%w", err)
		}
		if i == 0 && !out.Loaded {
			// From the request to the first usable token (D28); the
			// loading notices llama-swap streams meanwhile are not tokens.
			cold := s.toContent
			if cold <= 0 {
				cold = s.total
			}
			secs := round(cold.Seconds(), 1)
			out.ColdStartS = &secs
		}
	}

	measured := map[condition]schema.CaseResult{}
	for i, c := range cases {
		step(Step{Case: c.ID, Done: i, Message: fmt.Sprintf("正在測 %s（%d/%d）", c.ID, i+1, len(cases))})
		cond := conditionOf(c, tier)
		res, ok := measured[cond]
		if !ok {
			var err error
			res, err = ru.measure(ctx, c, tier, func(msg string) {
				step(Step{Case: c.ID, Done: i, Message: msg})
			})
			if ctx.Err() != nil {
				return out, ctx.Err()
			}
			if err != nil {
				out.Skipped = append(out.Skipped, c.ID+": "+err.Error())
				continue
			}
			measured[cond] = res
		}
		res.CaseID = c.ID
		out.Results = append(out.Results, res)
	}
	step(Step{Done: len(cases), Message: "測完了"})
	if len(out.Results) == 0 {
		return out, errors.New("每一項都沒有得到有效的成績：" + strings.Join(out.Skipped, "；"))
	}
	return out, nil
}

func (r *Runner) client() *http.Client {
	if r.Client != nil {
		return r.Client
	}
	return &http.Client{}
}

func (r *Runner) requestTimeout() time.Duration {
	if r.RequestTimeout > 0 {
		return r.RequestTimeout
	}
	return defaultRequestTimeout
}

func (r *Runner) warmupTimeout() time.Duration {
	if r.WarmupTimeout > 0 {
		return r.WarmupTimeout
	}
	return defaultWarmupTimeout
}

// Running is llama-swap's list of resident models, ready or not.
func (r *Runner) Running(ctx context.Context) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.Base+"/running", nil)
	if err != nil {
		return nil, err
	}
	resp, err := r.client().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var body struct {
		Running []struct {
			Model string `json:"model"`
			State string `json:"state"`
		} `json:"running"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, m := range body.Running {
		out[m.Model] = m.State
	}
	return out, nil
}

// Loaded says whether the model is resident and ready now.
func (r *Runner) Loaded(ctx context.Context, model string) bool {
	running, err := r.Running(ctx)
	return err == nil && running[model] == "ready"
}

// prefix makes every request's prompt start differently, so no engine
// serves any of it from a prefix cache (D25).
func prefix() string {
	b := make([]byte, 8)
	rand.Read(b)
	return "[" + hex.EncodeToString(b) + "]\n\n"
}

// compose is a request's text after the prefix: the filler as background,
// then the task.
func compose(header, filler, prompt string) string {
	return header + filler + "\n\n---\n\n" + prompt
}

// cut is the first n runes of the filler repeated end to end.
func cut(filler string, n int) string {
	if n <= 0 || filler == "" {
		return ""
	}
	unit := []rune(filler + "\n\n")
	out := make([]rune, 0, n)
	for len(out) < n {
		out = append(out, unit[:min(len(unit), n-len(out))]...)
	}
	return string(out)
}

// text is a case's request text, its filler sized to reach the case's
// depth. The size comes from probes (D23): not every engine can tokenize
// on request, but every one reports usage.prompt_tokens.
func (ru *run) text(ctx context.Context, c schema.BenchCase) (string, error) {
	s := ru.r.Suite
	prompt, ok := s.Prompts[c.PromptRef]
	if !ok {
		return "", fmt.Errorf("測試組沒有題目 %q", c.PromptRef)
	}
	lang, filler := fillerFor(s, c.Content)
	header := headerFor(lang)
	baseKey := c.PromptRef + "|" + lang
	ru.mu.Lock()
	base, haveBase := ru.base[baseKey]
	rate, haveRate := ru.rate[lang]
	ru.mu.Unlock()
	if !haveBase {
		n, err := ru.probe(ctx, prefix()+compose(header, "", prompt))
		if err != nil {
			return "", fmt.Errorf("校準深度失敗：%w", err)
		}
		base = n
		ru.mu.Lock()
		ru.base[baseKey] = n
		ru.mu.Unlock()
	}
	need := c.DepthTokens - base
	if need <= 0 {
		return compose(header, "", prompt), nil
	}
	if !haveRate {
		runes := len([]rune(filler))
		n, err := ru.probe(ctx, prefix()+compose(header, filler, prompt))
		if err != nil {
			return "", fmt.Errorf("校準深度失敗：%w", err)
		}
		if n <= base || runes == 0 {
			return "", fmt.Errorf("校準深度失敗：填充文字沒有增加 token（%d → %d）", base, n)
		}
		rate = float64(n-base) / float64(runes)
		ru.mu.Lock()
		ru.rate[lang] = rate
		ru.mu.Unlock()
	}
	return compose(header, cut(filler, int(float64(need)/rate)), prompt), nil
}

// probe is the prompt's length in tokens, read from a one-token reply.
func (ru *run) probe(ctx context.Context, content string) (int, error) {
	for attempt := 0; ; attempt++ {
		body := ru.body(content, 1, false)
		ctx, cancel := context.WithTimeout(ctx, probeTimeout)
		resp, err := ru.post(ctx, body)
		if err != nil {
			cancel()
			return 0, err
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		cancel()
		if resp.StatusCode != http.StatusOK {
			if ru.dropRefused(resp.StatusCode, raw) && attempt < len(droppable) {
				continue
			}
			return 0, upstreamError(resp.StatusCode, raw)
		}
		var reply struct {
			Usage *struct {
				PromptTokens int `json:"prompt_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal(raw, &reply); err != nil || reply.Usage == nil || reply.Usage.PromptTokens <= 0 {
			return 0, errors.New("引擎的回應沒有 usage.prompt_tokens")
		}
		return reply.Usage.PromptTokens, nil
	}
}

func (ru *run) ignoreEOS() bool {
	ru.mu.Lock()
	defer ru.mu.Unlock()
	return ru.r.Suite.IgnoreEOS && ignoreEOSEngines[ru.desc.Engine.Key] && !ru.dropped["ignore_eos"]
}

// body is one request under the fixed conditions of §7.2.
func (ru *run) body(content string, maxTokens int, stream bool) []byte {
	s := ru.r.Suite
	m := map[string]any{
		"model":       ru.desc.ModelID,
		"messages":    []map[string]string{{"role": "user", "content": content}},
		"max_tokens":  maxTokens,
		"temperature": s.Sampling.Temperature,
		"seed":        s.Sampling.Seed,
		"stream":      stream,
	}
	if stream {
		m["stream_options"] = map[string]any{"include_usage": true}
	}
	if !s.Thinking {
		// Both: each engine reads the one it knows (D25).
		m["chat_template_kwargs"] = map[string]any{"enable_thinking": false}
		m["reasoning_effort"] = "none"
	}
	if ru.ignoreEOS() {
		m["ignore_eos"] = true
	}
	ru.mu.Lock()
	for field := range ru.dropped {
		delete(m, field)
	}
	ru.mu.Unlock()
	b, _ := json.Marshal(m)
	return b
}

func (ru *run) post(ctx context.Context, body []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ru.r.Base+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return ru.r.client().Do(req)
}

// dropRefused leaves out, from now on, a field a 400 names.
func (ru *run) dropRefused(status int, body []byte) bool {
	if status != http.StatusBadRequest {
		return false
	}
	text := string(body)
	ru.mu.Lock()
	defer ru.mu.Unlock()
	for _, field := range droppable {
		if !ru.dropped[field] && strings.Contains(text, field) {
			ru.dropped[field] = true
			return true
		}
	}
	return false
}

func upstreamError(status int, body []byte) error {
	text := strings.TrimSpace(string(body))
	if len(text) > 300 {
		text = text[:300] + "…"
	}
	return fmt.Errorf("引擎回應 HTTP %d：%s", status, text)
}

// sample is one streamed reply, timed.
type sample struct {
	promptTokens     int
	completionTokens int
	toContent        time.Duration // request to the first content token
	toFirst          time.Duration // request to the first token of any kind
	decode           time.Duration // first token to last
	total            time.Duration
	draftN           int // llama.cpp's own speculative counts, when it sends them
	draftAccepted    int
}

type chunk struct {
	Choices []struct {
		Delta struct {
			Content          string `json:"content"`
			ReasoningContent string `json:"reasoning_content"`
			Reasoning        string `json:"reasoning"`
		} `json:"delta"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
	// llama-server's own numbers on the last chunk; only the draft
	// counts are used, the timing is measured from this side as for
	// every engine.
	Timings *struct {
		DraftN        int `json:"draft_n"`
		DraftAccepted int `json:"draft_n_accepted"`
	} `json:"timings"`
	Error json.RawMessage `json:"error"`
}

// send streams one reply and times it.
func (ru *run) send(ctx context.Context, timeout time.Duration, content string, maxTokens int) (sample, error) {
	for attempt := 0; ; attempt++ {
		s, status, raw, err := ru.stream(ctx, timeout, content, maxTokens)
		if status != 0 && status != http.StatusOK {
			if ru.dropRefused(status, raw) && attempt < len(droppable) {
				continue
			}
			return s, upstreamError(status, raw)
		}
		return s, err
	}
}

func (ru *run) stream(ctx context.Context, timeout time.Duration, content string, maxTokens int) (sample, int, []byte, error) {
	var s sample
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	start := time.Now()
	resp, err := ru.post(ctx, ru.body(content, maxTokens, true))
	if err != nil {
		return s, 0, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
		return s, resp.StatusCode, raw, nil
	}
	var first, firstContent, last time.Time
	chunks := 0
	reader := bufio.NewReaderSize(resp.Body, 64*1024)
	for {
		line, err := reader.ReadString('\n')
		if data, ok := strings.CutPrefix(strings.TrimSpace(line), "data:"); ok {
			data = strings.TrimSpace(data)
			if data == "[DONE]" {
				break
			}
			var c chunk
			if json.Unmarshal([]byte(data), &c) == nil {
				if len(c.Error) > 0 && string(c.Error) != "null" {
					return s, http.StatusOK, nil, fmt.Errorf("引擎在串流中回報錯誤：%s", truncate(string(c.Error), 300))
				}
				now := time.Now()
				for _, ch := range c.Choices {
					d := ch.Delta
					if d.Content == "" && d.ReasoningContent == "" && d.Reasoning == "" {
						continue
					}
					chunks++
					if first.IsZero() {
						first = now
					}
					if d.Content != "" && firstContent.IsZero() {
						firstContent = now
					}
					last = now
				}
				if c.Usage != nil {
					s.promptTokens = c.Usage.PromptTokens
					s.completionTokens = c.Usage.CompletionTokens
				}
				if c.Timings != nil && c.Timings.DraftN > 0 {
					s.draftN, s.draftAccepted = c.Timings.DraftN, c.Timings.DraftAccepted
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return s, http.StatusOK, nil, err
		}
	}
	s.total = time.Since(start)
	if first.IsZero() {
		return s, http.StatusOK, nil, errors.New("引擎沒有生成任何 token")
	}
	// An engine that leaves usage out is counted by chunks, which is right
	// one token per chunk and low when it speculates.
	if s.completionTokens == 0 {
		s.completionTokens = chunks
	}
	s.toFirst = first.Sub(start)
	if !firstContent.IsZero() {
		s.toContent = firstContent.Sub(start)
	}
	s.decode = last.Sub(first)
	return s, http.StatusOK, nil, nil
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

// measure runs one case: its repeats, each a round of N concurrent
// requests, every request with its own prefix.
func (ru *run) measure(ctx context.Context, c schema.BenchCase, tier string, progress func(string)) (schema.CaseResult, error) {
	s := ru.r.Suite
	text, err := ru.text(ctx, c)
	if err != nil {
		return schema.CaseResult{}, err
	}
	n := max(c.Concurrency, 1)
	repeats := repeatsFor(c, tier)
	minOut := int(math.Ceil(float64(s.OutputTokens) * s.MinOutputRatio))
	counters := ru.specCounters(ctx)

	var rates, ttfts, prompts, outputs, totals []float64
	var draftN, draftAccepted int
	var lastErr error
	for rep := 0; rep < repeats; rep++ {
		if repeats > 1 {
			progress(fmt.Sprintf("正在測 %s（第 %d/%d 次）", c.ID, rep+1, repeats))
		}
		// A round with no valid reply is tried once more: one short
		// answer should not lose the case on a quick run.
		for attempt := 0; attempt < 2; attempt++ {
			samples, errs := ru.round(ctx, text, n)
			if ctx.Err() != nil {
				return schema.CaseResult{}, ctx.Err()
			}
			// The round's throughput is every token over the window from the
			// first stream's first token to the last stream's last, not the
			// sum of the streams' own rates: an engine that serves one
			// request at a time decodes each stream at full speed in turn,
			// and summing those would multiply its throughput by N. The
			// requests leave together, so offsets from each one's start
			// share a clock.
			var roundTokens int
			var windowStart, windowEnd time.Duration
			valid := 0
			for i, smp := range samples {
				if errs[i] != nil {
					lastErr = errs[i]
					continue
				}
				if smp.completionTokens < minOut || smp.decode <= 0 {
					lastErr = fmt.Errorf("生成長度 %d 不到目標 %d 的 %.0f%%，不計", smp.completionTokens, s.OutputTokens, s.MinOutputRatio*100)
					continue
				}
				rate := float64(smp.completionTokens) / smp.decode.Seconds()
				ttft := smp.toContent
				if ttft <= 0 {
					ttft = smp.toFirst
				}
				rates = append(rates, rate)
				ttfts = append(ttfts, ttft.Seconds()*1000)
				if smp.promptTokens > 0 && ttft > 0 {
					prompts = append(prompts, float64(smp.promptTokens)/ttft.Seconds())
				}
				outputs = append(outputs, float64(smp.completionTokens))
				draftN += smp.draftN
				draftAccepted += smp.draftAccepted
				roundTokens += smp.completionTokens
				if valid == 0 || smp.toFirst < windowStart {
					windowStart = smp.toFirst
				}
				if end := smp.toFirst + smp.decode; end > windowEnd {
					windowEnd = end
				}
				valid++
			}
			if valid > 0 {
				if window := windowEnd - windowStart; window > 0 {
					totals = append(totals, float64(roundTokens)/window.Seconds())
				}
				break
			}
		}
	}
	if len(rates) == 0 {
		if lastErr == nil {
			lastErr = errors.New("沒有有效的樣本")
		}
		return schema.CaseResult{}, lastErr
	}
	gen, stdev := meanStdev(rates)
	ttft, _ := meanStdev(ttfts)
	promptTPS, _ := meanStdev(prompts)
	output, _ := meanStdev(outputs)
	res := schema.CaseResult{
		TTFTMs:       round(ttft, 1),
		PromptTPS:    round(promptTPS, 1),
		GenTPS:       round(gen, 2),
		GenTPSStdev:  round(stdev, 2),
		Samples:      len(rates),
		OutputTokens: round(output, 1),
		IgnoreEOS:    ru.ignoreEOS(),
	}
	if n > 1 && len(totals) > 0 {
		total, _ := meanStdev(totals)
		total = round(total, 2)
		res.TotalGenTPS = &total
	}
	if draftN > 0 {
		rate := round(float64(draftAccepted)/float64(draftN), 4)
		res.AcceptRate = &rate
	} else if counters != nil {
		if after := ru.specCounters(ctx); after != nil {
			if drafted := after.drafted - counters.drafted; drafted > 0 {
				rate := round((after.accepted-counters.accepted)/drafted, 4)
				res.AcceptRate = &rate
			}
		}
	}
	return res, nil
}

// round sends n requests at once and waits for all of them.
func (ru *run) round(ctx context.Context, text string, n int) ([]sample, []error) {
	samples := make([]sample, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range n {
		content := prefix() + text
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			samples[i], errs[i] = ru.send(ctx, ru.r.requestTimeout(), content, ru.r.Suite.OutputTokens)
		}()
	}
	close(start)
	wg.Wait()
	return samples, errs
}

type specCount struct{ accepted, drafted float64 }

// specCounters reads vLLM's speculative decoding counters through
// llama-swap's upstream passthrough; nil for another engine, or when the
// passthrough or the counters are not there (the accept rate is optional,
// D22).
func (ru *run) specCounters(ctx context.Context) *specCount {
	if ru.desc.Engine.Key != "vllm" {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ru.r.Base+"/upstream/"+url.PathEscape(ru.desc.ModelID)+"/metrics", nil)
	if err != nil {
		return nil
	}
	resp, err := ru.r.client().Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	accepted, okA := promSum(string(raw), "vllm:spec_decode_num_accepted_tokens_total")
	drafted, okD := promSum(string(raw), "vllm:spec_decode_num_draft_tokens_total")
	if !okA || !okD {
		return nil
	}
	return &specCount{accepted, drafted}
}

// promSum adds up one metric across its label sets in Prometheus text.
func promSum(text, name string) (float64, bool) {
	var sum float64
	found := false
	for _, line := range strings.Split(text, "\n") {
		rest, ok := strings.CutPrefix(line, name)
		if !ok || (rest != "" && rest[0] != '{' && rest[0] != ' ') {
			continue
		}
		if i := strings.LastIndexByte(rest, '}'); i >= 0 {
			rest = rest[i+1:]
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		if v, err := strconv.ParseFloat(fields[0], 64); err == nil {
			sum += v
			found = true
		}
	}
	return sum, found
}

func meanStdev(xs []float64) (mean, stdev float64) {
	if len(xs) == 0 {
		return 0, 0
	}
	for _, x := range xs {
		mean += x
	}
	mean /= float64(len(xs))
	if len(xs) < 2 {
		return mean, 0
	}
	var ss float64
	for _, x := range xs {
		ss += (x - mean) * (x - mean)
	}
	return mean, math.Sqrt(ss / float64(len(xs)-1))
}

func round(x float64, places int) float64 {
	p := math.Pow(10, float64(places))
	return math.Round(x*p) / p
}
