package httpapi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/NoobBandi/TenkStack/internal/llamaswap"
)

// A vLLM entry that speculates refuses min_p outright, inside a 200 stream
// the chat showed as nothing; the proxy leaves it out, and only there.
func TestFitForProviderDropsRefusedFields(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(`macros:
  vllm-intel: /x/vllm-intel.sh
  llama-intel: /x/llama-server-intel.sh
models:
  spec:
    cmd: |
      ${vllm-intel}
      --model /m
      --max-model-len 65536
      --speculative-config '{"method":"qwen3_5_mtp","num_speculative_tokens":3}'
  plain:
    cmd: |
      ${vllm-intel}
      --model /m
      --max-model-len 65536
  gguf:
    cmd: |
      ${llama-intel}
      --model /m.gguf
      --ctx-size 65536
`), 0o644)
	store := llamaswap.NewStore(path)
	store.SkipVerdict = true
	s := &Server{Config: store, Models: &llamaswap.Models{Store: store, Dir: dir}}

	fit := func(model string) map[string]any {
		body, _ := json.Marshal(map[string]any{"model": model, "min_p": 0.05, "logit_bias": map[string]int{"1": 2},
			"top_k": 20, "max_tokens": 131072})
		var out map[string]any
		json.Unmarshal(s.fitForProvider("chat/completions", body), &out)
		return out
	}
	if got := fit("spec"); got["min_p"] != nil || got["logit_bias"] != nil || got["top_k"] == nil || got["max_tokens"] != nil {
		t.Errorf("speculating vLLM entry: %v", got)
	}
	if got := fit("plain"); got["min_p"] == nil || got["max_tokens"] != nil {
		t.Errorf("plain vLLM entry keeps min_p and loses the oversized max_tokens: %v", got)
	}
	if got := fit("gguf"); got["min_p"] == nil || got["max_tokens"] == nil {
		t.Errorf("llama.cpp entry is left alone: %v", got)
	}
}

// The mux decodes %2F before the handler sees the path, so these are what
// /v1/..%2Flogs and its relatives arrive as.
func TestUpstreamPathStaysUnderV1(t *testing.T) {
	for _, p := range []string{"chat/completions", "models", "audio/transcriptions", "models/qwen3.6-27b"} {
		if !upstreamPath(p) {
			t.Errorf("%q should pass", p)
		}
	}
	for _, p := range []string{"../logs", "..", "a/../../api/captures/7", "./x", `..\logs`, "a?b", "a#b", "a%2e%2e"} {
		if upstreamPath(p) {
			t.Errorf("%q should be refused", p)
		}
	}
}
