package tuning

import "strings"

// sglangTable is SGLang's spelling of the same parameters, from its
// engine record (internal/providers/engines/sglang) and server arguments.
// Its flags are fewer and less settled than the other two engines', so
// only the ones with a clear counterpart are placed and the rest reported.
var sglangTable = []entry{
	{names: []string{"--context-length"},
		rule: intRule(func(b *builder, n int) { b.t.ContextLength = n })},
	// The share of the card for weights and KV pool, which is what vLLM's
	// --gpu-memory-utilization decides there; the engine record uses both
	// for the one "memory" field of the model form.
	{names: []string{"--mem-fraction-static"},
		rule: floatRule(func(b *builder, f float64) { b.t.GPUMemoryUtilization = &f })},
	{names: []string{"--quantization"}, rule: onlineQuantization},
	{names: []string{"--kv-cache-dtype"},
		rule: stringRule(func(b *builder, v string) {
			if t := kvType(v); t != "auto" {
				b.kv.TypeK, b.kv.TypeV = t, t
			}
		})},
	{names: []string{"--max-running-requests"},
		rule: intRule(func(b *builder, n int) { b.t.MaxConcurrency = &n })},
	{names: []string{"--reasoning-parser"},
		rule: stringRule(func(b *builder, v string) { b.reasoningParser = v })},
	// SGLang has no separate switch: naming a parser turns tool calls on.
	{names: []string{"--tool-call-parser"},
		rule: stringRule(func(b *builder, v string) { b.tools, b.autoTool, b.toolParser = true, true, v })},
	{names: []string{"--speculative-algorithm"}, rule: sglangAlgorithm},
	// Draft steps, each guessing one token at the default top-k of 1.
	{names: []string{"--speculative-num-steps"},
		rule: intRule(func(b *builder, n int) { b.numTokens = &n })},
	{names: []string{"--speculative-draft-model-path"},
		rule: stringRule(func(b *builder, v string) {
			b.methods["draft"] = true
			b.draft = draftModel("safetensors", v)
		})},
	{names: []string{"--enable-multimodal"}, bool: true, rule: vision(true)},

	// SGLang's prefix cache is its radix cache, on unless disabled.
	{names: []string{"--disable-radix-cache"}, bool: true,
		rule: func(b *builder, _, _ string, _, negated bool) bool {
			b.t.PrefixCache = ptr(negated)
			return true
		}},
	// No field for these yet.
	{names: []string{"--enable-mixed-chunk"}, bool: true},
	{names: []string{"--enable-torch-compile"}, bool: true},

	{names: []string{"--model-path", "--model"}, ignore: true},
	{names: []string{"--served-model-name"}, ignore: true},
	{names: []string{"--host"}, ignore: true},
	{names: []string{"--port"}, ignore: true},
	{names: []string{"--api-key"}, ignore: true},
	{names: []string{"--log-level"}, ignore: true},
	{names: []string{"--trust-remote-code"}, bool: true, ignore: true},
	{names: []string{"--tp-size", "--tp", "--tensor-parallel-size"}, ignore: true},
	{names: []string{"--dp-size", "--dp", "--data-parallel-size"}, ignore: true},
	// The XPU build's own requirements, which its engine record passes
	// (D11): the device, the attention backend and the page size it takes,
	// no overlap schedule; and the graph switch that is --enforce-eager's
	// counterpart.
	{names: []string{"--device"}, ignore: true},
	{names: []string{"--attention-backend"}, ignore: true},
	{names: []string{"--page-size"}, ignore: true},
	{names: []string{"--disable-overlap-schedule"}, bool: true, ignore: true},
	{names: []string{"--disable-cuda-graph"}, bool: true, ignore: true},
}

func sglangAlgorithm(b *builder, _, v string, has, _ bool) bool {
	switch strings.ToUpper(strings.TrimSpace(v)) {
	case "NEXTN":
		b.methods["mtp"] = true
	case "EAGLE":
		b.methods["eagle"] = true
	case "EAGLE3":
		b.methods["eagle3"] = true
	case "STANDALONE":
		b.methods["draft"] = true
	case "NGRAM":
		b.methods["ngram"] = true
	default:
		return false
	}
	return has
}
