package httpapi

import (
	"testing"
	"time"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
)

// A vLLM stream, split mid-line across reads, yields decode ticks while
// it runs and a done carrying the server's usage, plus the request's rate.
func TestMeterReadsAVLLMStream(t *testing.T) {
	var f feed
	events, stop := f.Subscribe()
	defer stop()
	m := newMeter(&f, "vLLM")
	chunk := func(text string) string {
		return `data: {"choices":[{"index":0,"delta":{"content":"` + text + `"}}]}` + "\n\n"
	}
	stream := chunk("a") + `data: {"choices":[{"index":0,"delta":{"reasoning":"hm"}}]}` + "\n\n"
	for i := 0; i < 8; i++ {
		stream += chunk("x")
	}
	stream += `data: {"choices":[],"usage":{"prompt_tokens":13,"total_tokens":23,"completion_tokens":10}}` + "\n\ndata: [DONE]\n\n"
	for i := 0; i < len(stream); i += 7 {
		end := i + 7
		if end > len(stream) {
			end = len(stream)
		}
		m.feedBytes([]byte(stream[i:end]))
		if i == 70 {
			time.Sleep(meterTick + 50*time.Millisecond)
		}
	}
	m.finish()
	if m.tokens != 10 {
		t.Errorf("counted %d tokens, want 10", m.tokens)
	}
	var sawDecode, sawDone, sawRate bool
	for len(events) > 0 {
		ev := <-events
		switch d := ev.Data.(type) {
		case api.ProgressTick:
			if d.Phase == "decode" {
				sawDecode = true
			}
			if d.Phase == "done" && d.Tokens == 23 {
				sawDone = true
			}
		case api.Throughput:
			sawRate = d.Tokens == 10 && d.TokensPerSecond > 0
		}
	}
	if !sawDecode || !sawDone || !sawRate {
		t.Errorf("decode %v done %v rate %v", sawDecode, sawDone, sawRate)
	}
}

// A reply that never produced text leaves no trace behind.
func TestMeterSilentOnEmptyReply(t *testing.T) {
	var f feed
	events, stop := f.Subscribe()
	defer stop()
	m := newMeter(&f, "vLLM")
	m.feedBytes([]byte("data: [DONE]\n\n"))
	m.finish()
	if len(events) != 0 {
		t.Errorf("%d events for an empty reply", len(events))
	}
}
