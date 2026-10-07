package tuning

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/NoobBandi/TenkStack/internal/schema"
)

// A golden case is a text file of sections: "-- engine --", "-- env --"
// (KEY=VALUE lines), "-- cmd --" (verbatim from config.yaml), "-- tuning --"
// (the expected Tuning as JSON) and "-- unrecognized --" (one name a
// line). Anything before the first section is a note on where it came from.
type golden struct {
	engine       string
	env          map[string]string
	cmd          string
	tuning       schema.Tuning
	unrecognized []string
}

var section = regexp.MustCompile(`(?m)^-- (\w+) --\n`)

func readGolden(t *testing.T, path string) golden {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	parts := map[string]string{}
	marks := section.FindAllStringSubmatchIndex(text, -1)
	for i, m := range marks {
		end := len(text)
		if i+1 < len(marks) {
			end = marks[i+1][0]
		}
		parts[text[m[2]:m[3]]] = text[m[1]:end]
	}
	g := golden{engine: strings.TrimSpace(parts["engine"]), env: map[string]string{}, cmd: parts["cmd"]}
	for _, line := range strings.Split(parts["env"], "\n") {
		if k, v, ok := strings.Cut(line, "="); ok {
			g.env[k] = v
		}
	}
	if err := json.Unmarshal([]byte(parts["tuning"]), &g.tuning); err != nil {
		t.Fatalf("%s: tuning: %v", path, err)
	}
	g.unrecognized = []string{}
	for _, line := range strings.Split(parts["unrecognized"], "\n") {
		if line = strings.TrimSpace(line); line != "" {
			g.unrecognized = append(g.unrecognized, line)
		}
	}
	return g
}

func pretty(t schema.Tuning) string {
	b, _ := json.MarshalIndent(t, "", "  ")
	return string(b)
}

// Every model entry on the machine this was written on, expectations
// written from what each flag means rather than from what the code said.
func TestGolden(t *testing.T) {
	files, _ := filepath.Glob("testdata/*.txt")
	if len(files) < 10 {
		t.Fatalf("only %d golden cases", len(files))
	}
	for _, f := range files {
		t.Run(strings.TrimSuffix(filepath.Base(f), ".txt"), func(t *testing.T) {
			g := readGolden(t, f)
			got, unrecognized := Parse(g.cmd, g.env, g.engine)
			if !reflect.DeepEqual(canonical(got), canonical(g.tuning)) {
				t.Errorf("tuning differs: %+v\ngot %s", Diff(g.tuning, got), pretty(got))
			}
			if !slices.Equal(unrecognized, g.unrecognized) {
				t.Errorf("unrecognized = %q, want %q", unrecognized, g.unrecognized)
			}
		})
	}
}

// Spellings and environment variables in the llama.cpp table are the ones
// llama-server prints, so a typo in the table is caught here rather than
// by a command that silently stops being read.
func TestLlamaTableMatchesHelp(t *testing.T) {
	raw, err := os.ReadFile("../flags/testdata/llama-server-f805c57.txt")
	if err != nil {
		t.Fatal(err)
	}
	help := string(raw)
	for _, e := range llamaCppTable {
		for _, n := range e.names {
			if !regexp.MustCompile(`(?m)(^|[ ,])` + regexp.QuoteMeta(n) + `([ ,]|$)`).MatchString(help) {
				t.Errorf("%s is not in llama-server's help", n)
			}
		}
		if e.env != "" && !strings.Contains(help, "(env: "+e.env+")") {
			t.Errorf("%s: env %s is not in llama-server's help", e.names[0], e.env)
		}
	}
}

func TestSpellings(t *testing.T) {
	long, _ := Parse(`${llama-sycl} --ctx-size 8192 --n-gpu-layers all --flash-attn on
		--cache-type-k q8_0 --cache-type-v q8_0 --parallel 4 --top-p 0.9 --kv-unified`, nil, LlamaCpp)
	for _, cmd := range []string{
		`${llama-sycl} -c 8192 -ngl all -fa on -ctk q8_0 -ctv q8_0 -np 4 --top_p 0.9 -kvu`,
		`${llama-sycl} --ctx-size=8192 --gpu-layers=all -fa=on --cache-type-v q8_0 --cache-type-k q8_0 -np=4 --top_p=0.9 --kv-unified`,
		"${llama-sycl} \\\n  -np 4 \\\n  # a comment line\n  -kvu --ctx-size \"8192\" -ngl 'all' -fa on -ctk q8_0 -ctv q8_0 --top-p 0.9",
	} {
		got, unrecognized := Parse(cmd, nil, LlamaCpp)
		if Hash(got) != Hash(long) || len(unrecognized) != 0 {
			t.Errorf("%q: %+v, unrecognized %q", cmd, Diff(long, got), unrecognized)
		}
	}
}

// llama.cpp reads LLAMA_ARG_* from its environment and lets the command
// line win.
func TestLlamaEnvironment(t *testing.T) {
	got, unrecognized := Parse("${llama-sycl} --ctx-size 4096", map[string]string{
		"LLAMA_ARG_CTX_SIZE":   "65536",
		"LLAMA_ARG_N_PARALLEL": "2",
		"LLAMA_ARG_KV_UNIFIED": "false",
		"LLAMA_ARG_HOST":       "0.0.0.0",
		// Names no flag, and an engine that is not llama.cpp would not
		// read these at all.
		"ONEAPI_DEVICE_SELECTOR": "level_zero:0",
		"LLAMA_NAME":             "llama-intel-x",
	}, LlamaCpp)
	if got.ContextLength != 4096 || got.MaxConcurrency == nil || *got.MaxConcurrency != 2 ||
		got.KVCache == nil || got.KVCache.Unified == nil || *got.KVCache.Unified || len(unrecognized) != 0 {
		t.Errorf("got %s, unrecognized %q", pretty(got), unrecognized)
	}
	if got, _ := Parse("${vllm-intel}", map[string]string{"LLAMA_ARG_CTX_SIZE": "65536"}, VLLM); got.ContextLength != 0 {
		t.Errorf("vLLM read llama.cpp's environment: %d", got.ContextLength)
	}
}

// A build's own help adds spellings the table lacks, and says which flags
// take a value; what it adds has no meaning here, so it is reported.
func TestHelpExtendsTable(t *testing.T) {
	help := []Flag{
		{Names: []string{"-c", "--ctx-size", "--context"}, Env: "LLAMA_ARG_CTX_SIZE", TakesValue: true},
		{Names: []string{"-swa", "--swa-full"}, Env: "LLAMA_ARG_SWA_FULL"},
		{Names: []string{"--fancy-thing"}, TakesValue: true},
	}
	got, unrecognized := ParseWith("${llama} --context 1024 -swa --fancy-thing 3 --model /m.gguf", nil, LlamaCpp, help)
	if got.ContextLength != 1024 || !slices.Equal(unrecognized, []string{"--fancy-thing", "--swa-full"}) {
		t.Errorf("got %s, unrecognized %q", pretty(got), unrecognized)
	}
	// Without the help -swa is unknown, and an unknown flag takes the next
	// word unless that is a flag.
	_, unrecognized = Parse("${llama} -swa --ctx-size 1024", nil, LlamaCpp)
	if !slices.Equal(unrecognized, []string{"-swa"}) {
		t.Errorf("unrecognized %q", unrecognized)
	}
}

func TestVLLMSpellings(t *testing.T) {
	want, _ := Parse(`${vllm-intel} --max-model-len 32768 --speculative-config '{"method":"qwen3_5_mtp","num_speculative_tokens":2}'
		--enable-auto-tool-choice --tool-call-parser hermes --kv-cache-dtype fp8`, nil, VLLM)
	for _, cmd := range []string{
		`${vllm-intel} --max_model_len 32K --speculative-config.method mtp --speculative-config.num_speculative_tokens 2 --enable_auto_tool_choice --tool_call_parser=hermes --kv-cache-dtype fp8_e4m3`,
		`${vllm-intel} --max-model-len=32768 -sc '{"method": "mtp"}' --spec-tokens 2 --tool-call-parser hermes --enable-auto-tool-choice --kv_cache_dtype=fp8`,
	} {
		got, unrecognized := Parse(cmd, nil, VLLM)
		if Hash(got) != Hash(want) || len(unrecognized) != 0 {
			t.Errorf("%q: %+v, unrecognized %q", cmd, Diff(want, got), unrecognized)
		}
	}
	if want.ContextLength != 32768 || want.Speculative == nil || want.Speculative.Methods[0] != "mtp" {
		t.Errorf("want = %s", pretty(want))
	}
}

func TestVLLMUnplaced(t *testing.T) {
	got, unrecognized := Parse(`vllm serve /models/x --no-enable-prefix-caching --quantization awq
		--speculative-config '{"method":"ngram","prompt_lookup_max":4}' --enforce-eager --no-enforce-eager
		--override-generation-config '{"temperature":0.7,"seed":1}' --compilation-config.mode 3`, nil, VLLM)
	want := []string{"--override-generation-config.seed", "--quantization", "--speculative-config.prompt_lookup_max"}
	if !slices.Equal(unrecognized, want) {
		t.Errorf("unrecognized = %q, want %q", unrecognized, want)
	}
	if got.OnlineQuantization != nil || got.Speculative == nil || got.Speculative.Methods[0] != "ngram" ||
		got.Sampling == nil || *got.Sampling.Temperature != 0.7 {
		t.Errorf("got %s", pretty(got))
	}
}

// An engine nothing is known about places nothing and reports every flag
// but the plainly local ones.
func TestOtherEngine(t *testing.T) {
	got, unrecognized := Parse("/opt/x/serve.sh --port ${PORT} --ctx 4096 --fast", nil, "mlx")
	if got.ContextLength != 0 || !slices.Equal(unrecognized, []string{"--ctx", "--fast"}) {
		t.Errorf("got %s, unrecognized %q", pretty(got), unrecognized)
	}
}

func TestHashIgnoresEmptyAndOrder(t *testing.T) {
	a := schema.Tuning{ContextLength: 8192, KVCache: &schema.KVCache{},
		Speculative: &schema.Speculative{Methods: []string{"ngram", "mtp"}}}
	b := schema.Tuning{ContextLength: 8192, Speculative: &schema.Speculative{Methods: []string{"mtp", "ngram"}}}
	if Hash(a) != Hash(b) {
		t.Errorf("%s != %s", Hash(a), Hash(b))
	}
	if len(Hash(a)) != 16 {
		t.Errorf("hash %q", Hash(a))
	}
	b.ContextLength = 4096
	if Hash(a) == Hash(b) {
		t.Error("different context, same hash")
	}
}

func TestDiff(t *testing.T) {
	a, _ := Parse("${llama} -c 131072 -ctk q8_0 -ctv q8_0 -np 2 --spec-type ngram-mod -sm layer -ts 6,5 --temp 1", nil, LlamaCpp)
	b, _ := Parse("${llama} -c 131072 -ctk f16 -ctv q8_0 -np 2 --spec-type draft-mtp,ngram-mod -sm layer --temp 1.0 -fa on", nil, LlamaCpp)
	want := []Change{
		{"flash_attention", "", "true"},
		{"kv_cache.type_k", "q8_0", "f16"},
		{"multi_gpu.tensor_split", "6,5", ""},
		{"speculative.methods", "ngram", "mtp,ngram"},
	}
	if got := Diff(a, b); !reflect.DeepEqual(got, want) {
		t.Errorf("Diff = %+v\nwant %+v", got, want)
	}
	if got := Diff(a, a); len(got) != 0 {
		t.Errorf("Diff(a, a) = %+v", got)
	}
}

func TestSplit(t *testing.T) {
	got := split("${x}\n--a '{\"k\": [1, 2]}'\n--b \"say \\\"hi\\\"\"\n# --c 1\n--d=e\\ f")
	want := []string{"${x}", "--a", `{"k": [1, 2]}`, "--b", `say "hi"`, "--d=e f"}
	if !slices.Equal(got, want) {
		t.Errorf("split = %q", got)
	}
}

// Draft heads keep their names and n-gram schemes their variant, so two
// different speculation setups never hash alike; prefix caching has a field.
func TestSpeculationVariantsAndPrefixCache(t *testing.T) {
	for _, c := range []struct {
		cmd, engine string
		methods     []string
		mode        string
	}{
		{"${llama} -m x.gguf --spec-type draft-eagle3", LlamaCpp, []string{"eagle3"}, ""},
		{"${llama} -m x.gguf --spec-type draft-dflash,ngram-map-k4v", LlamaCpp, []string{"dflash", "ngram"}, "map-k4v"},
		{`${vllm} --model m --speculative-config '{"method":"eagle3","num_speculative_tokens":3}'`, VLLM, []string{"eagle3"}, ""},
		{"${sglang} --model-path m --speculative-algorithm EAGLE3", SGLang, []string{"eagle3"}, ""},
	} {
		got, _ := Parse(c.cmd, nil, c.engine)
		if got.Speculative == nil || !slices.Equal(got.Speculative.Methods, c.methods) {
			t.Errorf("%s: speculative %s", c.cmd, pretty(got))
			continue
		}
		mode := ""
		if got.Speculative.NGram != nil {
			mode = got.Speculative.NGram.Mode
		}
		if mode != c.mode {
			t.Errorf("%s: ngram mode %q, want %q", c.cmd, mode, c.mode)
		}
	}
	on, _ := Parse("${vllm} --model m --enable-prefix-caching", nil, VLLM)
	off, _ := Parse("${vllm} --model m --no-enable-prefix-caching", nil, VLLM)
	if on.PrefixCache == nil || !*on.PrefixCache || off.PrefixCache == nil || *off.PrefixCache {
		t.Errorf("prefix cache: on %s, off %s", pretty(on), pretty(off))
	}
	if Hash(on) == Hash(off) {
		t.Error("prefix cache on and off hash alike")
	}
}
