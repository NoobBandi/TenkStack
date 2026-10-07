package tuning

import (
	"strings"

	"github.com/NoobBandi/TenkStack/internal/schema"
)

// llamaCppTable is the hand-kept half of the llama.cpp mapping (§8.3):
// what each flag means. Spellings and environment variables are the ones
// llama-server f805c57 prints in --help (internal/flags/testdata), so
// Parse works without asking a binary; ParseWith adds whatever the
// installed build prints on top.
var llamaCppTable = []entry{
	{names: []string{"--ctx-size", "-c"}, env: "LLAMA_ARG_CTX_SIZE",
		rule: intRule(func(b *builder, n int) { b.t.ContextLength = n })},
	{names: []string{"--cache-type-k", "-ctk"}, env: "LLAMA_ARG_CACHE_TYPE_K",
		rule: stringRule(func(b *builder, v string) { b.kv.TypeK = kvType(v) })},
	{names: []string{"--cache-type-v", "-ctv"}, env: "LLAMA_ARG_CACHE_TYPE_V",
		rule: stringRule(func(b *builder, v string) { b.kv.TypeV = kvType(v) })},
	{names: []string{"--kv-unified", "-kvu", "-no-kvu", "--no-kv-unified"}, env: "LLAMA_ARG_KV_UNIFIED", bool: true,
		rule: switchRule(func(b *builder, on *bool) { b.kv.Unified = on })},
	{names: []string{"--kv-unified-per-slot"}, env: "LLAMA_ARG_KV_UNIFIED_PER_SLOT",
		rule: intRule(func(b *builder, n int) { b.kv.PerSlotContext = &n })},
	{names: []string{"--cache-ram", "-cram"}, env: "LLAMA_ARG_CACHE_RAM",
		rule: intRule(func(b *builder, n int) { b.kv.HostCacheMiB = &n })},

	{names: []string{"--rope-scaling"}, env: "LLAMA_ARG_ROPE_SCALING_TYPE",
		rule: stringRule(func(b *builder, v string) { b.rope.Scaling = strings.ToLower(v) })},
	{names: []string{"--rope-scale"}, env: "LLAMA_ARG_ROPE_SCALE",
		rule: floatRule(func(b *builder, f float64) { b.rope.Factor = f })},
	{names: []string{"--yarn-orig-ctx"}, env: "LLAMA_ARG_YARN_ORIG_CTX",
		rule: intRule(func(b *builder, n int) { b.rope.OriginalContext = &n })},

	{names: []string{"--spec-type"}, env: "LLAMA_ARG_SPEC_TYPE", rule: llamaSpecType},
	{names: []string{"--spec-ngram-mod-n-match"},
		rule: intRule(func(b *builder, n int) { b.ngramOf().NMatch = n })},
	{names: []string{"--spec-ngram-mod-n-min"},
		rule: intRule(func(b *builder, n int) { b.ngramOf().NMin = n })},
	{names: []string{"--spec-ngram-mod-n-max"},
		rule: intRule(func(b *builder, n int) { b.ngramOf().NMax = n })},
	{names: []string{"--spec-draft-n-max"}, env: "LLAMA_ARG_SPEC_DRAFT_N_MAX",
		rule: intRule(func(b *builder, n int) { b.numTokens = &n })},
	// A draft model given at all is drafted from.
	{names: []string{"--spec-draft-model", "-md", "--model-draft"}, env: "LLAMA_ARG_SPEC_DRAFT_MODEL",
		rule: stringRule(func(b *builder, v string) {
			b.methods["draft"] = true
			b.draft = draftModel("gguf", v)
		})},

	// -1 is auto, which is what leaving it out means.
	{names: []string{"--parallel", "-np"}, env: "LLAMA_ARG_N_PARALLEL",
		rule: intRule(func(b *builder, n int) {
			if n < 0 {
				b.t.MaxConcurrency = nil
			} else {
				b.t.MaxConcurrency = &n
			}
		})},
	{names: []string{"--batch-size", "-b"}, env: "LLAMA_ARG_BATCH",
		rule: intRule(func(b *builder, n int) { b.batch.BatchSize = &n })},
	{names: []string{"--ubatch-size", "-ub"}, env: "LLAMA_ARG_UBATCH",
		rule: intRule(func(b *builder, n int) { b.batch.UBatchSize = &n })},
	{names: []string{"--split-mode", "-sm"}, env: "LLAMA_ARG_SPLIT_MODE",
		rule: stringRule(func(b *builder, v string) { b.multi.SplitMode = strings.ToLower(v) })},
	{names: []string{"--tensor-split", "-ts"}, env: "LLAMA_ARG_TENSOR_SPLIT", rule: llamaTensorSplit},
	{names: []string{"--flash-attn", "-fa"}, env: "LLAMA_ARG_FLASH_ATTN",
		rule: switchRule(func(b *builder, on *bool) { b.t.FlashAttention = on })},
	{names: []string{"--n-gpu-layers", "-ngl", "--gpu-layers"}, env: "LLAMA_ARG_N_GPU_LAYERS", rule: llamaGPULayers},
	{names: []string{"--n-cpu-moe", "-ncmoe"}, env: "LLAMA_ARG_N_CPU_MOE",
		rule: intRule(func(b *builder, n int) { b.t.CPUMoELayers = &n })},

	// The projector file is found locally (§4.1); whether one is loaded is
	// the parameter.
	{names: []string{"--mmproj", "-mm"}, env: "LLAMA_ARG_MMPROJ", rule: vision(true)},
	{names: []string{"--mmproj-url", "-mmu"}, env: "LLAMA_ARG_MMPROJ_URL", rule: vision(true)},
	// --mmproj-auto only fetches a projector alongside -hf, and on is its
	// default; its --no- forms are what turn vision off.
	{names: []string{"--mmproj-auto", "--no-mmproj", "--no-mmproj-auto"}, env: "LLAMA_ARG_MMPROJ_AUTO", bool: true,
		rule: func(b *builder, _, _ string, _, negated bool) bool {
			if negated {
				b.t.Vision = ptr(false)
			}
			return true
		}},

	{names: []string{"--temperature", "--temp"}, env: "LLAMA_ARG_TEMPERATURE",
		rule: floatRule(func(b *builder, f float64) { b.sampling.Temperature = &f })},
	{names: []string{"--top-k"}, env: "LLAMA_ARG_TOP_K",
		rule: intRule(func(b *builder, n int) { b.sampling.TopK = &n })},
	{names: []string{"--top-p"}, env: "LLAMA_ARG_TOP_P",
		rule: floatRule(func(b *builder, f float64) { b.sampling.TopP = &f })},
	{names: []string{"--min-p"}, env: "LLAMA_ARG_MIN_P",
		rule: floatRule(func(b *builder, f float64) { b.sampling.MinP = &f })},
	{names: []string{"--repeat-penalty"}, env: "LLAMA_ARG_REPEAT_PENALTY",
		rule: floatRule(func(b *builder, f float64) { b.sampling.RepeatPenalty = &f })},
	{names: []string{"--presence-penalty"}, env: "LLAMA_ARG_PRESENCE_PENALTY",
		rule: floatRule(func(b *builder, f float64) { b.sampling.PresencePenalty = &f })},

	{names: []string{"--reasoning", "-rea"}, env: "LLAMA_ARG_REASONING",
		rule: switchRule(func(b *builder, on *bool) { b.thinking = on })},
	{names: []string{"--chat-template-kwargs"}, env: "LLAMA_ARG_CHAT_TEMPLATE_KWARGS",
		rule: jsonRule("--chat-template-kwargs")},

	// §9.3 is undecided on the template file (Q6): it changes what the
	// model is shown, but it is a file on this machine. Reported for now.
	{names: []string{"--chat-template-file"}, env: "LLAMA_ARG_CHAT_TEMPLATE_FILE"},
	{names: []string{"--cpu-moe", "-cmoe"}, env: "LLAMA_ARG_CPU_MOE", bool: true},

	// Not a recipe's (§9.2): where the model is and how it is served.
	{names: []string{"--model", "-m"}, env: "LLAMA_ARG_MODEL", ignore: true},
	{names: []string{"--model-url", "-mu"}, env: "LLAMA_ARG_MODEL_URL", ignore: true},
	{names: []string{"--hf-repo", "-hf", "-hfr"}, env: "LLAMA_ARG_HF_REPO", ignore: true},
	{names: []string{"--hf-file", "-hff"}, env: "LLAMA_ARG_HF_FILE", ignore: true},
	{names: []string{"--hf-token", "-hft"}, env: "HF_TOKEN", ignore: true},
	{names: []string{"--host"}, env: "LLAMA_ARG_HOST", ignore: true},
	{names: []string{"--port"}, env: "LLAMA_ARG_PORT", ignore: true},
	{names: []string{"--alias", "-a"}, env: "LLAMA_ARG_ALIAS", ignore: true},
	{names: []string{"--api-key"}, env: "LLAMA_API_KEY", ignore: true},
	{names: []string{"--api-key-file"}, env: "LLAMA_ARG_API_KEY_FILE", ignore: true},
	{names: []string{"--jinja", "--no-jinja"}, env: "LLAMA_ARG_JINJA", bool: true, ignore: true},
	{names: []string{"--metrics"}, env: "LLAMA_ARG_ENDPOINT_METRICS", bool: true, ignore: true},
	{names: []string{"--slots", "--no-slots"}, env: "LLAMA_ARG_ENDPOINT_SLOTS", bool: true, ignore: true},
	{names: []string{"--props"}, env: "LLAMA_ARG_ENDPOINT_PROPS", bool: true, ignore: true},
	{names: []string{"--verbose", "-v", "--log-verbose"}, bool: true, ignore: true},
	{names: []string{"--log-verbosity", "-lv", "--verbosity"}, env: "LLAMA_ARG_LOG_VERBOSITY", ignore: true},
	{names: []string{"--log-file"}, env: "LLAMA_ARG_LOG_FILE", ignore: true},
	{names: []string{"--timeout", "-to"}, env: "LLAMA_ARG_TIMEOUT", ignore: true},
	// Which cards (D10) and the CPU threads, which follow the machine
	// rather than the model (Q7).
	{names: []string{"--device", "-dev"}, env: "LLAMA_ARG_DEVICE", ignore: true},
	{names: []string{"--main-gpu", "-mg"}, env: "LLAMA_ARG_MAIN_GPU", ignore: true},
	{names: []string{"--threads", "-t"}, env: "LLAMA_ARG_THREADS", ignore: true},
	{names: []string{"--threads-batch", "-tb"}, ignore: true},
	// Platform fixes (D11): how the weights are read in, and --fit, which
	// rewrites unset arguments to fit the cards in hand.
	{names: []string{"--load-mode", "-lm"}, env: "LLAMA_ARG_LOAD_MODE", ignore: true},
	{names: []string{"--no-host"}, env: "LLAMA_ARG_NO_HOST", bool: true, ignore: true},
	{names: []string{"--fit", "-fit"}, env: "LLAMA_ARG_FIT", ignore: true},
	{names: []string{"--fit-target", "-fitt"}, env: "LLAMA_ARG_FIT_TARGET", ignore: true},
	{names: []string{"--fit-ctx", "-fitc"}, env: "LLAMA_ARG_FIT_CTX", ignore: true},
}

func (b *builder) ngramOf() *schema.NGram {
	if b.ngram == nil {
		b.ngram = &schema.NGram{}
	}
	return b.ngram
}

func vision(on bool) rule {
	return func(b *builder, _, _ string, _, _ bool) bool {
		b.t.Vision = ptr(on)
		return true
	}
}

// llamaSpec maps --spec-type's choices onto the schema's methods. The
// draft heads keep their names, because an EAGLE3 head and a DFlash model
// are different recipes; the n-gram schemes are one method whose variant
// goes in ngram.mode (ngramModes).
var llamaSpec = map[string]string{
	"draft-mtp":    "mtp",
	"draft-simple": "draft", "draft-eagle3": "eagle3", "draft-dflash": "dflash", "draft-dspark": "dspark",
	"ngram-mod": "ngram", "ngram-simple": "ngram", "ngram-map-k": "ngram", "ngram-map-k4v": "ngram", "ngram-cache": "ngram",
}

func llamaSpecType(b *builder, _, v string, has, _ bool) bool {
	if !has {
		return false
	}
	ok := true
	for _, item := range strings.Split(v, ",") {
		item = strings.ToLower(strings.TrimSpace(item))
		if m, known := llamaSpec[item]; known {
			b.methods[m] = true
			if m == "ngram" {
				b.ngramModes[strings.TrimPrefix(item, "ngram-")] = true
			}
		} else if item != "none" && item != "" {
			ok = false
		}
	}
	return ok
}

// llamaTensorSplit reads "6,5"; llama.cpp also takes "6/5".
func llamaTensorSplit(b *builder, _, v string, has, _ bool) bool {
	if !has {
		return false
	}
	var split []float64
	for _, part := range strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == '/' }) {
		f, ok := atof(part)
		if !ok {
			return false
		}
		split = append(split, f)
	}
	b.multi.TensorSplit = split
	return len(split) > 0
}

// llamaGPULayers reads a count, "all", or "auto" -- the default, so unset.
func llamaGPULayers(b *builder, _, v string, has, _ bool) bool {
	switch v = strings.ToLower(strings.TrimSpace(v)); {
	case !has:
		return false
	case v == "all":
		b.t.GPULayers = &schema.GPULayers{All: true}
	case v == "auto":
		b.t.GPULayers = nil
	default:
		n, ok := atoi(v)
		if !ok {
			return false
		}
		b.t.GPULayers = &schema.GPULayers{Count: n}
	}
	return true
}
