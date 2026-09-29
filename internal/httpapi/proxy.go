package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/NoobBandi/TenkStack/internal/images"
	"github.com/NoobBandi/TenkStack/internal/providers"
)

// logRequestShape reports the shape of a completion request, never the
// prompt text: third-party agents are opaque about which knobs they send,
// and this proxy is the one place that sees the bytes.
func logRequestShape(path string, body []byte, r *http.Request) {
	if len(body) == 0 {
		return
	}
	shape := ""
	switch {
	case strings.HasPrefix(path, "chat/completions"):
		shape = "openai"
	case strings.HasPrefix(path, "messages") && !strings.HasPrefix(path, "messages/count"):
		shape = "anthropic"
	case strings.HasPrefix(path, "responses"):
		shape = "responses"
	default:
		return
	}
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil {
		return
	}
	agent := r.Header.Get("User-Agent")
	if len(agent) > 40 {
		agent = agent[:40]
	}
	if agent == "" {
		agent = "?"
	}
	tools, _ := payload["tools"].([]any)
	if shape == "responses" {
		items, _ := payload["input"].([]any)
		var kinds []string
		for _, item := range items {
			m, _ := item.(map[string]any)
			if m == nil || m["type"] != "function_call_output" {
				continue
			}
			switch out := m["output"].(type) {
			case string:
				kinds = append(kinds, "<string>")
			case []any:
				for _, part := range out {
					if p, ok := part.(map[string]any); ok {
						if t, ok := p["type"].(string); ok {
							kinds = append(kinds, t)
						} else {
							kinds = append(kinds, "<no type>")
						}
					} else {
						kinds = append(kinds, "<other>")
					}
				}
			}
		}
		log.Printf("/v1 responses from %s: model=%v input=%d tools=%d tool_output_types=%v", agent, payload["model"], len(items), len(tools), kinds)
		return
	}
	messages, _ := payload["messages"].([]any)
	turns := len(messages)
	if shape == "anthropic" && payload["system"] != nil {
		turns++
	}
	multimodal := false
	for _, m := range messages {
		if mm, ok := m.(map[string]any); ok {
			if _, isList := mm["content"].([]any); isList {
				multimodal = true
			}
		}
	}
	reasoning := map[string]any{}
	for _, key := range []string{"chat_template_kwargs", "reasoning_budget_tokens", "thinking", "reasoning", "reasoning_effort", "enable_thinking"} {
		if v, ok := payload[key]; ok {
			reasoning[key] = v
		}
	}
	maxTokens := payload["max_tokens"]
	if maxTokens == nil {
		maxTokens = payload["max_completion_tokens"]
	}
	log.Printf("/v1 %s request from %s: model=%v messages=%d tools=%d stream=%v max_tokens=%v temperature=%v multimodal=%v reasoning_fields=%v",
		shape, agent, payload["model"], turns, len(tools), payload["stream"], maxTokens, payload["temperature"], multimodal, reasoning)
}

var droppedHeaders = map[string]bool{"host": true, "authorization": true, "x-api-key": true, "cookie": true, "content-length": true, "connection": true}

// proxyV1 forwards /v1/* to llama-swap behind the console's authentication,
// streaming the response so a completion arrives token by token.
func (s *Server) proxyV1(w http.ResponseWriter, r *http.Request) {
	path := r.PathValue("path")
	body, err := io.ReadAll(r.Body)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	logRequestShape(path, body, r)
	// A format llama.cpp's decoder cannot read is re-encoded here rather
	// than rejected upstream.
	body = images.Transcode(body)

	if r.Method == http.MethodPost && strings.HasSuffix(path, "chat/completions") && len(body) > 0 && s.Settings.Get("vision_cache") != 0 {
		var payload map[string]any
		if json.Unmarshal(body, &payload) == nil && payload != nil {
			if rewritten, replaced := s.Vision.Rewrite(payload); replaced > 0 {
				if b, err := json.Marshal(rewritten); err == nil {
					body = b
					log.Printf("vision cache: %d image(s) served as description", replaced)
				}
			}
		}
	}
	// Only requests that name a model can cause one to be loaded; reads must
	// not stall behind an eviction.
	model := ""
	if r.Method == http.MethodPost && len(body) > 0 {
		var probe struct {
			Model any `json:"model"`
		}
		if json.Unmarshal(body, &probe) == nil {
			if wanted, ok := probe.Model.(string); ok {
				model = wanted
				if status, detail := s.makeRoom(r.Context(), wanted); status != 0 {
					fail(w, status, detail)
					return
				}
			}
		}
	}

	body = s.fitForProvider(path, body)
	body, asked := s.askUsagePerChunk(path, body)

	target := s.LlamaSwap.Base + "/v1/" + path
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	upstream, err := http.NewRequestWithContext(r.Context(), r.Method, target, bytes.NewReader(body))
	if err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	for key, values := range r.Header {
		if droppedHeaders[strings.ToLower(key)] {
			continue
		}
		for _, v := range values {
			upstream.Header.Add(key, v)
		}
	}
	resp, err := (&http.Client{}).Do(upstream)
	if err != nil {
		fail(w, http.StatusBadGateway, "llama-swap unreachable: "+err.Error())
		return
	}
	defer resp.Body.Close()
	contentType := resp.Header.Get("Content-Type")
	if contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	if strings.Contains(contentType, "event-stream") {
		w.Header().Set("Cache-Control", "no-cache")
	}
	w.WriteHeader(resp.StatusCode)
	flusher, _ := w.(http.Flusher)
	// A streamed reply from an engine that logs nothing per request is
	// measured on its way through; llama.cpp reports its own.
	var m *meter
	if resp.StatusCode == http.StatusOK && strings.Contains(contentType, "event-stream") && model != "" &&
		strings.HasSuffix(path, "completions") {
		if key := s.Models.ProviderKeys()[s.Config.CanonicalModel(model)]; key != "" && formOf(key) != providers.FormLlama {
			name := key
			if p := providers.Get(key); p != nil {
				name = p.Name
			}
			m = newMeter(&s.meters, s.measured(), s.Config.CanonicalModel(model), name)
			defer m.finish()
		}
	}
	// The usage the proxy asked for is read here and taken out again before
	// the client sees the stream.
	var filter *usageFilter
	if asked != nil && strings.Contains(contentType, "event-stream") {
		filter = &usageFilter{asked: *asked}
	}
	buf := make([]byte, 32*1024)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			if m != nil {
				m.feedBytes(buf[:n])
			}
			out := buf[:n]
			if filter != nil {
				out = filter.feed(out)
			}
			if _, werr := w.Write(out); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			if filter != nil {
				w.Write(filter.flush())
			}
			return
		}
	}
}

// measured is the book of what the proxy measured, kept where the server
// was told to keep it.
func (s *Server) measured() *meterBook {
	s.bookOnce.Do(func() { s.book.Path = s.MeterHistory })
	return &s.book
}

// fitForProvider bends a request to what the model's runtime accepts.
// llama-server treats max_tokens as a ceiling and stops at the context;
// vLLM refuses the request outright when it exceeds the context, and the
// console's chat -- and any client that says "as much as you can" the
// llama-server way -- sends numbers far above it. For such an engine the
// field goes when it is over the context, and the engine then uses what is
// left. Fields the entry would refuse as it is started -- vLLM's min_p
// while it speculates -- go too, since a refusal arrives as an error inside
// a 200 stream that most clients show as nothing at all.
func (s *Server) fitForProvider(path string, body []byte) []byte {
	if !strings.HasSuffix(path, "completions") || len(body) == 0 {
		return body
	}
	var payload map[string]any
	if json.Unmarshal(body, &payload) != nil || payload == nil {
		return body
	}
	model, _ := payload["model"].(string)
	if model == "" {
		return body
	}
	id := s.Config.CanonicalModel(model)
	changed := false
	for _, key := range s.Models.Refused()[id] {
		if _, ok := payload[key]; ok {
			delete(payload, key)
			changed = true
		}
	}
	if p := providers.Get(s.Models.ProviderKeys()[id]); p != nil && p.DropMaxTokens {
		ctx := s.Models.ContextSizes()[id]
		for _, key := range []string{"max_tokens", "max_completion_tokens"} {
			if n, ok := payload[key].(float64); ok && ctx > 0 && int(n) >= ctx {
				delete(payload, key)
				changed = true
			}
		}
	}
	if !changed {
		return body
	}
	if b, err := json.Marshal(payload); err == nil {
		return b
	}
	return body
}
