package httpapi

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/NoobBandi/TenkStack/server-go/internal/providers"
)

// usageAsked is what a client itself put in stream_options, before the
// proxy asked the engine for usage on every chunk.
type usageAsked struct {
	final bool // include_usage: one usage-only chunk at the end
	every bool // continuous_usage_stats: usage on every chunk
}

// askUsagePerChunk makes a streamed completion to an engine that can say so
// report its running token counts on every chunk, and returns what the
// client asked for itself so the stream can be put back to that. nil when
// the request is left alone.
func (s *Server) askUsagePerChunk(path string, body []byte) ([]byte, *usageAsked) {
	if path != "chat/completions" && path != "completions" {
		return body, nil
	}
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil || payload == nil {
		return body, nil
	}
	if stream, _ := payload["stream"].(bool); !stream {
		return body, nil
	}
	model, _ := payload["model"].(string)
	p := providers.Get(s.Models.ProviderKeys()[s.Config.CanonicalModel(model)])
	if p == nil || !p.UsagePerChunk {
		return body, nil
	}
	opts, _ := payload["stream_options"].(map[string]any)
	if opts == nil {
		opts = map[string]any{}
	}
	asked := &usageAsked{}
	asked.final, _ = opts["include_usage"].(bool)
	asked.every, _ = opts["continuous_usage_stats"].(bool)
	opts["include_usage"], opts["continuous_usage_stats"] = true, true
	payload["stream_options"] = opts
	b, err := json.Marshal(payload)
	if err != nil {
		return body, nil
	}
	return b, asked
}

// usageFilter takes the usage the proxy asked for back out of a stream, so
// the client reads what the engine would have sent it: usage on every chunk
// only if it asked for that, the usage-only chunk at the end if it asked for
// include_usage, and otherwise none.
type usageFilter struct {
	asked   usageAsked
	pending []byte
}

// feed returns the complete lines in b, rewritten; a partial line waits
// for the rest of it.
func (f *usageFilter) feed(b []byte) []byte {
	f.pending = append(f.pending, b...)
	end := bytes.LastIndexByte(f.pending, '\n')
	if end < 0 {
		return nil
	}
	var out bytes.Buffer
	for _, line := range bytes.SplitAfter(f.pending[:end+1], []byte("\n")) {
		out.Write(f.line(line))
	}
	f.pending = append(f.pending[:0], f.pending[end+1:]...)
	return out.Bytes()
}

// flush returns whatever partial line is left at the end of the stream.
func (f *usageFilter) flush() []byte {
	rest := f.pending
	f.pending = nil
	return rest
}

func (f *usageFilter) line(line []byte) []byte {
	if f.asked.every {
		return line
	}
	body := bytes.TrimSpace(line)
	if !bytes.HasPrefix(body, []byte("data:")) {
		return line
	}
	payload := bytes.TrimSpace(body[5:])
	if len(payload) == 0 || payload[0] != '{' || !bytes.Contains(payload, []byte(`"usage"`)) {
		return line
	}
	var chunk map[string]json.RawMessage
	if json.Unmarshal(payload, &chunk) != nil {
		return line
	}
	usage, ok := chunk["usage"]
	if !ok || string(usage) == "null" {
		return line
	}
	var choices []json.RawMessage
	json.Unmarshal(chunk["choices"], &choices)
	if len(choices) == 0 {
		// The usage-only chunk at the end: the client's if it asked.
		if f.asked.final {
			return line
		}
		return nil
	}
	delete(chunk, "usage")
	b, err := json.Marshal(chunk)
	if err != nil {
		return line
	}
	eol := line[len(strings.TrimRight(string(line), "\r\n")):]
	return append(append([]byte("data: "), b...), eol...)
}
