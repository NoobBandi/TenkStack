package httpapi

import (
	"bytes"
	"encoding/json"
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
// Tokens are counted as the deltas that carry text -- one per chunk, which
// is what vLLM sends without speculative decoding -- and replaced by the
// usage the server reports at the end, when the client asked for it. The
// prompt is known only from that usage, so a live curve starts at zero.

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

// meter reads one streamed reply as it is copied to the client.
type meter struct {
	feed    *feed
	engine  string
	task    int
	started time.Time
	first   time.Time
	last    time.Time
	tokens  int
	usage   *struct {
		Prompt     int `json:"prompt_tokens"`
		Completion int `json:"completion_tokens"`
	}
	// Recent (time, count) samples for the three-second window.
	window  []sample
	pending []byte
}

type sample struct {
	at     time.Time
	tokens int
}

func newMeter(f *feed, engine string) *meter {
	return &meter{feed: f, engine: engine, task: int(meterTask.Add(1)), started: time.Now()}
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
		} `json:"choices"`
		Usage *struct {
			Prompt     int `json:"prompt_tokens"`
			Completion int `json:"completion_tokens"`
		} `json:"usage"`
	}
	if json.Unmarshal(payload, &chunk) != nil {
		return
	}
	if chunk.Usage != nil {
		m.usage = chunk.Usage
	}
	for _, c := range chunk.Choices {
		d := c.Delta
		if d.Content != "" || d.Reasoning != "" || d.ReasoningContent != "" || len(d.ToolCalls) > 0 {
			if m.first.IsZero() {
				m.first = time.Now()
				m.last = m.first
			}
			m.tokens++
		}
	}
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
		Slot: 0, Task: m.task, Phase: "decode", Tokens: m.tokens, Rate: &rate, Average: &avg, Engine: m.engine,
	}})
}

// finish closes the trace and reports the request's rate, the way
// llama-server's eval-time line does.
func (m *meter) finish() {
	if m.first.IsZero() {
		return
	}
	now := time.Now()
	m.tick(now)
	generated, window := m.tokens, m.tokens
	if m.usage != nil {
		generated = m.usage.Completion
		window = m.usage.Prompt + m.usage.Completion
	}
	truncated := false
	m.feed.publish(api.Event{Type: "progress", Data: api.ProgressTick{
		Slot: 0, Task: m.task, Phase: "done", Tokens: window, Truncated: &truncated, Engine: m.engine,
	}})
	decode := now.Sub(m.first)
	if generated > 0 && decode > 0 {
		m.feed.publish(api.Event{Type: "throughput", Data: api.Throughput{
			EvalMs: float64(decode.Milliseconds()), Tokens: generated,
			TokensPerSecond: float64(generated) / decode.Seconds(),
		}})
	}
}
