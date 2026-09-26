package httpapi

import (
	"bytes"
	"encoding/json"
	"log"
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
)

// The overview's request progress and its "上一次" rate are read out of
// llama-server's own log lines -- prompt progress, tg_3s, eval time --
// which llama-swap forwards. Another engine prints none of them: vLLM logs
// a ten-second average for the whole server and nothing per request. So for
// a model that is not llama.cpp the reply is measured here, on its way
// through the proxy, and the same events are published: a tick per half
// second while it streams, a done when it ends, and the request's rate.
//
// An engine that can put its running token counts on every chunk is asked
// to (askUsagePerChunk), and those counts are the measurement: a chunk
// carries several tokens when the engine speculates, so counting chunks read
// a third of the real rate. The prompt is known from the first chunk, and
// the curve starts there. An engine that cannot is counted a token per chunk
// that carries text, corrected by the usage at the end if the client asked.

// feed fans the proxy's events out to every open browser stream.
type feed struct {
	mu   sync.Mutex
	subs map[chan api.Event]struct{}
}

func (f *feed) Subscribe() (<-chan api.Event, func()) {
	ch := make(chan api.Event, 64)
	f.mu.Lock()
	if f.subs == nil {
		f.subs = map[chan api.Event]struct{}{}
	}
	f.subs[ch] = struct{}{}
	f.mu.Unlock()
	return ch, func() {
		f.mu.Lock()
		delete(f.subs, ch)
		f.mu.Unlock()
	}
}

func (f *feed) publish(ev api.Event) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for ch := range f.subs {
		select {
		case ch <- ev:
		default: // a slow page loses a tick rather than stalling the reply
		}
	}
}

// Task numbers for measured requests, far above any llama-server's own, so
// a trace from the log and one from here can never share a key.
var meterTask atomic.Int64

func init() { meterTask.Store(1 << 30) }

const meterTick = 500 * time.Millisecond

type usage struct {
	Prompt     int `json:"prompt_tokens"`
	Completion int `json:"completion_tokens"`
}

// meter reads one streamed reply as it is copied to the client.
type meter struct {
	feed    *feed
	book    *meterBook
	model   string
	engine  string
	task    int
	started time.Time
	first   time.Time
	last    time.Time
	tokens  int
	prompt  int
	// perChunk: the engine reports running counts, so tokens is theirs.
	perChunk bool
	usage    *usage
	// Recent (time, count) samples for the three-second window.
	window  []sample
	pending []byte
}

type sample struct {
	at     time.Time
	tokens int
}

func newMeter(f *feed, book *meterBook, model, engine string) *meter {
	m := &meter{feed: f, book: book, model: model, engine: engine, task: int(meterTask.Add(1)), started: time.Now()}
	book.start(m)
	return m
}

// feedBytes takes whatever arrived and reads the complete lines in it.
func (m *meter) feedBytes(b []byte) {
	m.pending = append(m.pending, b...)
	for {
		i := bytes.IndexByte(m.pending, '\n')
		if i < 0 {
			break
		}
		line := bytes.TrimSpace(m.pending[:i])
		m.pending = m.pending[i+1:]
		m.line(line)
	}
	if now := time.Now(); !m.first.IsZero() && now.Sub(m.last) >= meterTick {
		m.last = now
		m.tick(now)
	}
}

func (m *meter) line(line []byte) {
	if !bytes.HasPrefix(line, []byte("data:")) {
		return
	}
	payload := bytes.TrimSpace(line[5:])
	if len(payload) == 0 || payload[0] != '{' {
		return
	}
	var chunk struct {
		Choices []struct {
			Delta struct {
				Content          string `json:"content"`
				Reasoning        string `json:"reasoning"`
				ReasoningContent string `json:"reasoning_content"`
				ToolCalls        []any  `json:"tool_calls"`
			} `json:"delta"`
			Text string `json:"text"`
		} `json:"choices"`
		Usage *usage `json:"usage"`
	}
	if json.Unmarshal(payload, &chunk) != nil {
		return
	}
	if u := chunk.Usage; u != nil {
		m.usage = u
		if len(chunk.Choices) > 0 {
			if !m.perChunk {
				m.perChunk = true
				// The prompt is in from the first chunk on, before a token
				// of the reply: the curve starts at its height.
				m.prompt = u.Prompt
				m.publishPrompt()
			}
			m.tokens = u.Completion
		}
	}
	for _, c := range chunk.Choices {
		d := c.Delta
		if d.Content != "" || d.Reasoning != "" || d.ReasoningContent != "" || len(d.ToolCalls) > 0 || c.Text != "" {
			if m.first.IsZero() {
				m.first = time.Now()
				m.last = m.first
			}
			if !m.perChunk {
				m.tokens++
			}
		}
	}
}

func (m *meter) elapsed(now time.Time) *float64 {
	e := now.Sub(m.started).Seconds()
	return &e
}

// publishPrompt is the prefill tick llama-server's log would have given.
func (m *meter) publishPrompt() {
	m.feed.publish(api.Event{Type: "progress", Data: api.ProgressTick{
		Slot: 0, Task: m.task, Phase: "prefill", Tokens: m.prompt, Elapsed: m.elapsed(time.Now()), Engine: m.engine,
	}})
}

func (m *meter) tick(now time.Time) {
	m.window = append(m.window, sample{now, m.tokens})
	for len(m.window) > 1 && now.Sub(m.window[0].at) > 3*time.Second {
		m.window = m.window[1:]
	}
	var rate float64
	if w := m.window[0]; now.Sub(w.at) > 0 && len(m.window) > 1 {
		rate = float64(m.tokens-w.tokens) / now.Sub(w.at).Seconds()
	} else if d := now.Sub(m.first).Seconds(); d > 0 {
		rate = float64(m.tokens) / d
	}
	avg := 0.0
	if d := now.Sub(m.first).Seconds(); d > 0 {
		avg = float64(m.tokens) / d
	}
	m.feed.publish(api.Event{Type: "progress", Data: api.ProgressTick{
		Slot: 0, Task: m.task, Phase: "decode", Tokens: m.tokens, Rate: &rate, Average: &avg,
		Elapsed: m.elapsed(now), Engine: m.engine,
	}})
}

// finish closes the trace and reports the request's rate, the way
// llama-server's eval-time line does.
func (m *meter) finish() {
	defer m.book.end(m)
	if m.first.IsZero() {
		return
	}
	now := time.Now()
	m.tick(now)
	generated, prompt := m.tokens, m.prompt
	if m.usage != nil {
		generated, prompt = m.usage.Completion, m.usage.Prompt
	}
	truncated := false
	m.feed.publish(api.Event{Type: "progress", Data: api.ProgressTick{
		Slot: 0, Task: m.task, Phase: "done", Tokens: prompt + generated, Truncated: &truncated, Engine: m.engine,
	}})
	decode := now.Sub(m.first)
	if generated > 0 && decode > 0 {
		rate := float64(generated) / decode.Seconds()
		m.feed.publish(api.Event{Type: "throughput", Data: api.Throughput{
			EvalMs: float64(decode.Milliseconds()), Tokens: generated, TokensPerSecond: rate,
		}})
		// Only a count the engine gave is history: a count of chunks is
		// not a rate worth plotting against depth.
		if m.usage != nil && generated >= minMeasured {
			model := m.model
			row := api.ActivityRow{Ts: now.Unix(), Model: &model, Input: int64(prompt), Output: int64(generated),
				Depth: int64(prompt), TokensPerSecond: rate, DurationMs: now.Sub(m.started).Milliseconds()}
			if wait := m.first.Sub(m.started).Seconds(); wait > 0 && prompt > 0 {
				row.PromptPerSecond = float64(prompt) / wait
			}
			m.book.record(row)
		}
	}
}

// Below this a reply says nothing about sustained speed; the activity
// store's own floor.
const minMeasured = 20

// meterBook is what the proxy has measured, by model: the replies streaming
// now and the last one finished, which stand in for the /slots a server
// engine does not have, and each finished reply's rate against the depth it
// started at, kept on disk for the overview.
type meterBook struct {
	mu   sync.Mutex
	live map[string]map[int]*meter
	last map[string]int
	rows []api.ActivityRow
	// Path is where rows are kept between restarts; empty keeps them in
	// memory only.
	Path   string
	loaded bool
}

const meterRows = 1000

func (b *meterBook) start(m *meter) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.live == nil {
		b.live = map[string]map[int]*meter{}
	}
	if b.live[m.model] == nil {
		b.live[m.model] = map[int]*meter{}
	}
	b.live[m.model][m.task] = m
}

func (b *meterBook) end(m *meter) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.live[m.model], m.task)
	if m.prompt+m.tokens > 0 {
		if b.last == nil {
			b.last = map[string]int{}
		}
		b.last[m.model] = m.prompt + m.tokens
	}
}

// Slots is a model's occupancy the way llama-server's /slots gives it: a
// busy slot per reply streaming now, or else the last reply's length, which
// the prefix cache still holds. nil when nothing has been measured.
func (b *meterBook) Slots(model string, nctx int) []api.Slot {
	b.mu.Lock()
	defer b.mu.Unlock()
	var tasks []int
	for task := range b.live[model] {
		tasks = append(tasks, task)
	}
	sort.Ints(tasks)
	var out []api.Slot
	for i, task := range tasks {
		m := b.live[model][task]
		out = append(out, api.Slot{ID: i, NCtx: nctx, Used: m.prompt + m.tokens, Busy: true})
	}
	if len(out) == 0 {
		if used, ok := b.last[model]; ok {
			out = append(out, api.Slot{ID: 0, NCtx: nctx, Used: used})
		}
	}
	return out
}

func (b *meterBook) load() {
	if b.loaded {
		return
	}
	b.loaded = true
	if b.Path == "" {
		return
	}
	raw, err := os.ReadFile(b.Path)
	if err != nil {
		return
	}
	if json.Unmarshal(raw, &b.rows) != nil {
		b.rows = nil
	}
}

func (b *meterBook) record(row api.ActivityRow) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.load()
	b.rows = append(b.rows, row)
	if len(b.rows) > meterRows {
		b.rows = b.rows[len(b.rows)-meterRows:]
	}
	if b.Path == "" {
		return
	}
	raw, err := json.Marshal(b.rows)
	if err == nil {
		tmp := b.Path + ".tmp"
		if err = os.WriteFile(tmp, raw, 0o600); err == nil {
			err = os.Rename(tmp, b.Path)
		}
	}
	if err != nil {
		log.Printf("could not keep the measured request history: %v", err)
	}
}

// Recent is the measured rows, newest first, for one model or all.
func (b *meterBook) Recent(limit int, model string) []api.ActivityRow {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.load()
	out := []api.ActivityRow{}
	for i := len(b.rows) - 1; i >= 0 && len(out) < limit; i-- {
		if r := b.rows[i]; model == "" || (r.Model != nil && *r.Model == model) {
			out = append(out, r)
		}
	}
	return out
}

// Measured is the models with rows here, whose rows from llama-swap's store
// are estimates to leave out.
func (b *meterBook) Measured() map[string]bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.load()
	out := map[string]bool{}
	for _, r := range b.rows {
		if r.Model != nil {
			out[*r.Model] = true
		}
	}
	return out
}
