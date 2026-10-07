package tuning

import (
	"encoding/json"
	"path"
	"sort"
	"strconv"
	"strings"

	"github.com/NoobBandi/TenkStack/internal/schema"
)

// builder collects values as flags arrive and assembles the Tuning at the
// end, because some fields need more than one flag: whether a model
// reasons is the parser and the template's default together, and a JSON
// flag can be given whole and then key by key.
type builder struct {
	t        schema.Tuning
	kv       schema.KVCache
	rope     schema.Rope
	batch    schema.Batch
	multi    schema.MultiGPU
	sampling schema.Sampling

	methods map[string]bool
	// ngramModes are the n-gram variants named, folded into ngram.mode.
	ngramModes map[string]bool
	numTokens  *int
	ngram      *schema.NGram
	draft      *schema.ModelRef

	thinking        *bool
	reasoningParser string
	tools           bool
	autoTool        bool
	toolParser      string

	// JSON flags by canonical name, keys merged in the order given.
	json    map[string]map[string]any
	readers map[string]reader

	unplaced map[string]bool
}

func newBuilder(d *dialect) *builder {
	return &builder{
		methods: map[string]bool{}, ngramModes: map[string]bool{}, json: map[string]map[string]any{},
		readers: d.readers, unplaced: map[string]bool{},
	}
}

func (b *builder) unknown(name string) { b.unplaced[name] = true }

func (b *builder) unrecognized() []string {
	out := make([]string, 0, len(b.unplaced))
	for n := range b.unplaced {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

func (b *builder) finish() schema.Tuning {
	flags := make([]string, 0, len(b.json))
	for f := range b.json {
		flags = append(flags, f)
	}
	sort.Strings(flags)
	for _, f := range flags {
		if r := b.readers[f]; r != nil {
			r(b, f, b.json[f])
		}
	}

	t := b.t
	if b.kv != (schema.KVCache{}) {
		kv := b.kv
		t.KVCache = &kv
	}
	if b.rope.Scaling != "" || b.rope.Factor != 0 || b.rope.OriginalContext != nil {
		rope := b.rope
		t.Rope = &rope
	}
	if b.batch != (schema.Batch{}) {
		batch := b.batch
		t.Batch = &batch
	}
	if b.multi.SplitMode != "" || len(b.multi.TensorSplit) > 0 {
		multi := b.multi
		t.MultiGPU = &multi
	}
	if b.sampling != (schema.Sampling{}) {
		sampling := b.sampling
		t.Sampling = &sampling
	}
	// Speculation settings without a method switch nothing on; they would
	// only make two identical setups look different.
	if len(b.methods) > 0 {
		s := &schema.Speculative{NumTokens: b.numTokens, DraftModel: b.draft}
		for m := range b.methods {
			s.Methods = append(s.Methods, m)
		}
		sort.Strings(s.Methods)
		if b.methods["ngram"] {
			s.NGram = b.ngram
			if len(b.ngramModes) > 0 {
				modes := make([]string, 0, len(b.ngramModes))
				for m := range b.ngramModes {
					modes = append(modes, m)
				}
				sort.Strings(modes)
				if s.NGram == nil {
					s.NGram = &schema.NGram{}
				}
				s.NGram.Mode = strings.Join(modes, ",")
			}
		}
		t.Speculative = s
	}
	if b.thinking != nil || b.reasoningParser != "" {
		// A reasoning parser alone means the template's default, which for
		// every family that has a parser is to think.
		enabled := b.thinking == nil || *b.thinking
		t.Reasoning = &schema.Switch{Enabled: enabled, Parser: b.reasoningParser}
	}
	if b.tools || b.toolParser != "" {
		t.Tools = &schema.Switch{Enabled: b.autoTool, Parser: b.toolParser}
	}
	return t
}

// setJSON merges a JSON flag: the whole object, or one dotted key.
func (b *builder) setJSON(flag, key, value string) bool {
	m := b.json[flag]
	if m == nil {
		m = map[string]any{}
		b.json[flag] = m
	}
	if key != "" {
		m[key] = value
		return true
	}
	var whole map[string]any
	if err := json.Unmarshal([]byte(value), &whole); err != nil {
		return false
	}
	for k, v := range whole {
		m[k] = v
	}
	return true
}

// Value parsing. A value the table cannot read -- an unexpanded macro, a
// typo -- leaves the field unset and the flag reported.

func atoi(s string) (int, bool) {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	return n, err == nil
}

func atof(s string) (float64, bool) {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return f, err == nil
}

// size reads vLLM's human-readable integers: 1k is 1000 and 1K is 1024.
func size(s string) (int, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	mult := 1.0
	switch s[len(s)-1] {
	case 'k':
		mult = 1e3
	case 'K':
		mult = 1 << 10
	case 'm':
		mult = 1e6
	case 'M':
		mult = 1 << 20
	case 'g':
		mult = 1e9
	case 'G':
		mult = 1 << 30
	}
	if mult == 1 {
		return atoi(s)
	}
	f, ok := atof(s[:len(s)-1])
	return int(f * mult), ok
}

// toggle reads a switch's value: on/off, true/false, 1/0, enabled/disabled.
// auto means the engine decides, which is the same as not setting it.
func toggle(value string, has, negated bool) (on, auto, ok bool) {
	if !has {
		return !negated, false, true
	}
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "on", "true", "1", "yes", "enabled":
		return !negated, false, true
	case "off", "false", "0", "no", "disabled":
		return negated, false, true
	case "auto":
		return false, true, true
	}
	return false, false, false
}

func ptr[T any](v T) *T { return &v }

// Rule builders for the common shapes.

func intRule(set func(*builder, int)) rule {
	return func(b *builder, _, v string, has, _ bool) bool {
		n, ok := atoi(v)
		if !has || !ok {
			return false
		}
		set(b, n)
		return true
	}
}

func sizeRule(set func(*builder, int)) rule {
	return func(b *builder, _, v string, has, _ bool) bool {
		n, ok := size(v)
		if !has || !ok {
			return false
		}
		set(b, n)
		return true
	}
}

func floatRule(set func(*builder, float64)) rule {
	return func(b *builder, _, v string, has, _ bool) bool {
		f, ok := atof(v)
		if !has || !ok {
			return false
		}
		set(b, f)
		return true
	}
}

func stringRule(set func(*builder, string)) rule {
	return func(b *builder, _, v string, has, _ bool) bool {
		v = strings.TrimSpace(v)
		if !has || v == "" {
			return false
		}
		set(b, v)
		return true
	}
}

// switchRule sets a tri-state: on, off, or (auto) left to the engine.
func switchRule(set func(*builder, *bool)) rule {
	return func(b *builder, _, v string, has, negated bool) bool {
		on, auto, ok := toggle(v, has, negated)
		if !ok {
			return false
		}
		if auto {
			set(b, nil)
		} else {
			set(b, &on)
		}
		return true
	}
}

func jsonRule(flag string) rule {
	return func(b *builder, key, v string, has, _ bool) bool {
		return has && b.setJSON(flag, key, v)
	}
}

// kvType folds the engines' names for one cache precision into llama.cpp's.
func kvType(v string) string {
	switch v = strings.ToLower(strings.TrimSpace(v)); v {
	case "fp8_e4m3":
		return "fp8"
	case "bfloat16":
		return "bf16"
	case "float16", "half":
		return "f16"
	case "float32", "float":
		return "f32"
	}
	return v
}

// draftModel names a draft model by its file or directory alone: the path
// to it is this machine's (§11.1).
func draftModel(format, v string) *schema.ModelRef {
	name := path.Base(strings.TrimRight(v, "/"))
	if format == "gguf" {
		return &schema.ModelRef{Format: format, File: name}
	}
	// A Hugging Face id is the model's identity as it is; a local
	// directory is named like the repository it was downloaded from.
	if !strings.HasPrefix(v, "/") && !strings.HasPrefix(v, "$") && strings.Count(v, "/") == 1 {
		return &schema.ModelRef{Format: format, Repo: v}
	}
	return &schema.ModelRef{Format: format, Repo: name}
}

// Readers shared between engines.

// readTemplateKwargs takes the template's default for thinking, the one
// key of chat-template kwargs that is a tuning choice.
func readTemplateKwargs(b *builder, flag string, m map[string]any) {
	for k, v := range m {
		if k != "enable_thinking" {
			b.unknown(flag + "." + k)
			continue
		}
		on, ok := jsonBool(v)
		if !ok {
			b.unknown(flag + "." + k)
			continue
		}
		b.thinking = &on
	}
}

func jsonBool(v any) (bool, bool) {
	switch x := v.(type) {
	case bool:
		return x, true
	case string:
		on, auto, ok := toggle(x, true, false)
		return on, ok && !auto
	}
	return false, false
}

func jsonFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case string:
		return atof(x)
	}
	return 0, false
}

func jsonInt(v any) (int, bool) {
	f, ok := jsonFloat(v)
	if !ok || f != float64(int(f)) {
		return 0, false
	}
	return int(f), true
}

func jsonString(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok && s != ""
}
