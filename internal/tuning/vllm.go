package tuning

import "strings"

// vllmTable is vLLM's flag mapping, spelled as `vllm serve --help=all`
// prints it in v0.30.0. Underscored spellings (--max_model_len) and
// dotted JSON keys (--speculative-config.method) are folded before the
// lookup, as vLLM itself does.
var vllmTable = []entry{
	{names: []string{"--max-model-len"},
		rule: maxModelLen},
	{names: []string{"--kv-cache-dtype"},
		rule: stringRule(func(b *builder, v string) {
			// One setting for both halves of the cache.
			if t := kvType(v); t != "auto" {
				b.kv.TypeK, b.kv.TypeV = t, t
			}
		})},
	{names: []string{"--max-num-seqs"},
		rule: sizeRule(func(b *builder, n int) { b.t.MaxConcurrency = &n })},
	{names: []string{"--max-num-batched-tokens"},
		rule: sizeRule(func(b *builder, n int) { b.batch.MaxBatchedTokens = &n })},
	{names: []string{"--gpu-memory-utilization"},
		rule: floatRule(func(b *builder, f float64) { b.t.GPUMemoryUtilization = &f })},
	{names: []string{"--quantization", "-q"}, rule: onlineQuantization},

	{names: []string{"--speculative-config", "-sc"}, rule: jsonRule("--speculative-config")},
	// Shorthands for keys of --speculative-config.
	{names: []string{"--spec-method"}, rule: specKey("method")},
	{names: []string{"--spec-tokens"}, rule: specKey("num_speculative_tokens")},
	{names: []string{"--spec-model"}, rule: specKey("model")},

	{names: []string{"--reasoning-parser"},
		rule: stringRule(func(b *builder, v string) { b.reasoningParser = v })},
	{names: []string{"--default-chat-template-kwargs"}, rule: jsonRule("--default-chat-template-kwargs")},
	{names: []string{"--enable-auto-tool-choice"}, bool: true,
		rule: func(b *builder, _, _ string, _, negated bool) bool {
			b.tools, b.autoTool = true, !negated
			return true
		}},
	{names: []string{"--tool-call-parser"},
		rule: stringRule(func(b *builder, v string) { b.toolParser = v })},
	{names: []string{"--override-generation-config"}, rule: jsonRule("--override-generation-config")},
	// The vision tower is loaded unless this says otherwise.
	{names: []string{"--language-model-only"}, bool: true,
		rule: func(b *builder, _, _ string, _, negated bool) bool {
			if !negated {
				b.t.Vision = ptr(false)
			}
			return true
		}},

	// Switches the schema has no field for yet (prefix caching aside);
	// named so a value after them is not taken for theirs.
	{names: []string{"--enable-prefix-caching"}, bool: true,
		rule: func(b *builder, _, _ string, _, negated bool) bool {
			b.t.PrefixCache = ptr(!negated)
			return true
		}},
	{names: []string{"--enable-chunked-prefill"}, bool: true},
	{names: []string{"--enable-expert-parallel", "-ep"}, bool: true},

	// Not a tuning parameter: the model, how it is served, and the card
	// count.
	{names: []string{"--model"}, ignore: true},
	{names: []string{"--served-model-name"}, ignore: true},
	{names: []string{"--host"}, ignore: true},
	{names: []string{"--port"}, ignore: true},
	{names: []string{"--api-key"}, ignore: true},
	{names: []string{"--download-dir"}, ignore: true},
	{names: []string{"--trust-remote-code"}, bool: true, ignore: true},
	{names: []string{"--uvicorn-log-level"}, ignore: true},
	{names: []string{"--disable-log-stats"}, bool: true, ignore: true},
	{names: []string{"--enable-log-requests"}, bool: true, ignore: true},
	{names: []string{"--disable-log-requests"}, bool: true, ignore: true},
	{names: []string{"--tensor-parallel-size", "-tp"}, ignore: true},
	{names: []string{"--pipeline-parallel-size", "-pp"}, ignore: true},
	{names: []string{"--data-parallel-size", "-dp"}, ignore: true},
	{names: []string{"--device"}, ignore: true},
	// Engine and platform fixes the engine record owns.
	{names: []string{"--compilation-config", "-cc"}, ignore: true},
	{names: []string{"--enforce-eager"}, bool: true, ignore: true},
	{names: []string{"--distributed-executor-backend"}, ignore: true},
}

// maxModelLen reads 262144, 256k or 256K; -1 and auto leave the length to
// the engine, as an unset context does.
func maxModelLen(b *builder, _, v string, has, _ bool) bool {
	if !has {
		return false
	}
	if s := strings.ToLower(strings.TrimSpace(v)); s == "auto" || s == "-1" {
		b.t.ContextLength = 0
		return true
	}
	n, ok := size(v)
	if ok {
		b.t.ContextLength = n
	}
	return ok
}

// onlineQuantization takes the methods that quantise plain weights while
// loading. Any other --quantization names the checkpoint's own format,
// which is the model's identity (ModelRef.quant), not a tuning choice.
// fp8_per_tensor is vLLM 0.31's name for what 0.30 called fp8; both are
// "fp8" here, so a recipe reads the same on either side of the rename.
func onlineQuantization(b *builder, _, v string, has, _ bool) bool {
	if v = strings.ToLower(strings.TrimSpace(v)); !has || (v != "fp8" && v != "fp8_per_tensor") {
		return false
	}
	v = "fp8"
	b.t.OnlineQuantization = &v
	return true
}

func specKey(key string) rule {
	return func(b *builder, _, v string, has, _ bool) bool {
		return has && b.setJSON("--speculative-config", key, v)
	}
}

// vllmMethod maps vLLM's speculative methods onto the schema's: every
// model family's own *_mtp is MTP, the named heads keep their names, and
// the other separate models are drafts.
func vllmMethod(m string) (string, bool) {
	m = strings.ToLower(m)
	switch {
	case strings.Contains(m, "mtp"):
		return "mtp", true
	case m == "ngram" || m == "ngram_gpu":
		return "ngram", true
	case m == "eagle" || m == "eagle3" || m == "dflash" || m == "dspark":
		return m, true
	case m == "medusa" || m == "draft_model" || m == "mlp_speculator":
		return "draft", true
	}
	return "", false
}

func readVLLMSpeculative(b *builder, flag string, m map[string]any) {
	method, hasMethod := "", false
	for k, v := range m {
		switch k {
		case "method":
			s, ok := jsonString(v)
			if method, hasMethod = "", false; ok {
				method, hasMethod = vllmMethod(s)
			}
			if !hasMethod {
				b.unknown(flag + ".method")
			}
		case "num_speculative_tokens":
			if n, ok := jsonInt(v); ok {
				b.numTokens = &n
			} else {
				b.unknown(flag + "." + k)
			}
		case "model":
			if s, ok := jsonString(v); ok {
				b.draft = draftModel("safetensors", s)
			} else {
				b.unknown(flag + "." + k)
			}
		default:
			b.unknown(flag + "." + k)
		}
	}
	switch {
	case hasMethod:
		b.methods[method] = true
	case b.draft != nil && m["method"] == nil:
		// vLLM works the method out from the model; all that is known
		// here is that one was given.
		b.methods["draft"] = true
	}
}

func readGenerationConfig(b *builder, flag string, m map[string]any) {
	for k, v := range m {
		f, ok := jsonFloat(v)
		switch {
		case !ok:
			b.unknown(flag + "." + k)
		case k == "temperature":
			b.sampling.Temperature = &f
		case k == "top_p":
			b.sampling.TopP = &f
		case k == "top_k":
			if n, ok := jsonInt(v); ok {
				b.sampling.TopK = &n
			} else {
				b.unknown(flag + "." + k)
			}
		case k == "min_p":
			b.sampling.MinP = &f
		case k == "repetition_penalty":
			b.sampling.RepeatPenalty = &f
		case k == "presence_penalty":
			b.sampling.PresencePenalty = &f
		default:
			b.unknown(flag + "." + k)
		}
	}
}
