package httpapi

import (
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/NoobBandi/TenkStack/internal/api"
)

// A vLLM stream, split mid-line across reads, yields decode ticks while
// it runs and a done carrying the server's usage, plus the request's rate.
func TestMeterReadsAVLLMStream(t *testing.T) {
	var f feed
	events, stop := f.Subscribe()
	defer stop()
	m := newMeter(&f, &meterBook{}, "m", "vLLM")
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
	m := newMeter(&f, &meterBook{}, "m", "vLLM")
	m.feedBytes([]byte("data: [DONE]\n\n"))
	m.finish()
	if len(events) != 0 {
		t.Errorf("%d events for an empty reply", len(events))
	}
}

// With usage on every chunk the engine's counts are the measurement: a chunk
// of several speculated tokens counts as several, the prompt is known from
// the first chunk, and the model's slot and history follow.
func TestMeterUsesPerChunkUsage(t *testing.T) {
	var f feed
	events, stop := f.Subscribe()
	defer stop()
	book := &meterBook{}
	m := newMeter(&f, book, "vllm-model", "vLLM")
	chunk := func(text string, completion int) string {
		return `data: {"choices":[{"index":0,"delta":{"content":"` + text + `"}}],"usage":{"prompt_tokens":500,"total_tokens":0,"completion_tokens":` +
			strconv.Itoa(completion) + `}}` + "\n\n"
	}
	m.feedBytes([]byte(`data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}],"usage":{"prompt_tokens":500,"total_tokens":500,"completion_tokens":0}}` + "\n\n"))
	for i := 1; i <= 10; i++ {
		m.feedBytes([]byte(chunk("abc", i*4)))
	}
	if sl := book.Slots("vllm-model", 4096); len(sl) != 1 || !sl[0].Busy || sl[0].Used != 540 {
		t.Errorf("slot while streaming: %+v", sl)
	}
	m.feedBytes([]byte(`data: {"choices":[],"usage":{"prompt_tokens":500,"total_tokens":540,"completion_tokens":40}}` + "\n\ndata: [DONE]\n\n"))
	time.Sleep(20 * time.Millisecond)
	m.finish()
	if m.tokens != 40 {
		t.Errorf("counted %d tokens from ten chunks of four, want 40", m.tokens)
	}
	if sl := book.Slots("vllm-model", 4096); len(sl) != 1 || sl[0].Busy || sl[0].Used != 540 || sl[0].NCtx != 4096 {
		t.Errorf("slot after: %+v", sl)
	}
	rows := book.Recent(10, "vllm-model")
	if len(rows) != 1 || rows[0].Depth != 500 || rows[0].Output != 40 || rows[0].TokensPerSecond <= 0 {
		t.Errorf("history %+v", rows)
	}
	var prefill bool
	for len(events) > 0 {
		if d, ok := (<-events).Data.(api.ProgressTick); ok && d.Phase == "prefill" && d.Tokens == 500 {
			prefill = true
		}
	}
	if !prefill {
		t.Error("no prefill tick carrying the prompt")
	}
}

// The usage the proxy asked for is taken out again, so each client reads
// what the engine would have sent it.
func TestUsageFilter(t *testing.T) {
	stream := `data: {"choices":[{"delta":{"content":"a"}}],"usage":{"prompt_tokens":5,"completion_tokens":1}}` + "\n\n" +
		`data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}` + "\n\n" + "data: [DONE]\n\n"
	run := func(asked usageAsked) string {
		f := &usageFilter{asked: asked}
		var out string
		for i := 0; i < len(stream); i += 9 {
			end := min(i+9, len(stream))
			out += string(f.feed([]byte(stream[i:end])))
		}
		return out + string(f.flush())
	}
	none := run(usageAsked{})
	if strings.Contains(none, "usage") || !strings.Contains(none, `"content":"a"`) || !strings.Contains(none, "[DONE]") {
		t.Errorf("asked for nothing:\n%s", none)
	}
	final := run(usageAsked{final: true})
	if strings.Count(final, `"usage"`) != 1 || !strings.Contains(final, `"choices":[],"usage"`) {
		t.Errorf("asked for the final usage:\n%s", final)
	}
	if every := run(usageAsked{final: true, every: true}); every != stream {
		t.Errorf("asked for every chunk's usage, got a changed stream:\n%s", every)
	}
}

// Where the proxy measured a model, llama-swap's estimates for it give way.
func TestMergeActivity(t *testing.T) {
	book := &meterBook{}
	vl, ll := "vllm-model", "llama-model"
	book.record(api.ActivityRow{Ts: int64(300), Model: &vl, TokensPerSecond: 60})
	rows := []api.ActivityRow{
		{Ts: int64(400), Model: &vl, TokensPerSecond: 0.4, Estimated: true},
		{Ts: int64(200), Model: &ll, TokensPerSecond: 20},
	}
	got := mergeActivity(rows, book, 10, "")
	if len(got) != 2 || *got[0].Model != vl || got[0].TokensPerSecond != 60 || *got[1].Model != ll {
		t.Errorf("merged %+v", got)
	}
}
