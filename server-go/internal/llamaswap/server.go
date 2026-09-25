package llamaswap

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/NoobBandi/TenkStack/server-go/internal/providers"
)

// An entry for a server engine -- vLLM, SGLang, any record whose form is
// "server" -- has the same shape as a llama.cpp one: the launcher macro on
// the first line, one flag per line under it, so everything that reads a
// cmd (which launcher, which card, which files) works on all of them. The
// flags are the engine's own, as its record spells each field of the form:
// --max-model-len for vLLM where SGLang says --context-length, and no layer
// count because a server engine either fits or does not.
//
// The served-name flag carries the entry's id. llama-swap forwards the
// request body as the client sent it, and these servers refuse a request
// whose model field names anything but a name they were started with.

// flagAt matches a flag as a word of the cmd, so --model is never found in
// --model-path or --served-model-name.
func flagAt(flag, value string) *regexp.Regexp {
	return regexp.MustCompile(`(?:^|\s)` + regexp.QuoteMeta(flag) + `\s+` + value)
}

var (
	patternsMu sync.Mutex
	patterns   = map[string]map[string]*regexp.Regexp{}
)

// serverPatterns read a server entry's fields back, keyed by the names the
// editor's fields had before there was more than one server engine.
func serverPatterns(p providers.Provider) map[string]*regexp.Regexp {
	patternsMu.Lock()
	defer patternsMu.Unlock()
	if got, ok := patterns[p.Key]; ok {
		return got
	}
	out := map[string]*regexp.Regexp{}
	for field, spec := range map[string]struct{ name, value string }{
		providers.FlagModel:          {"model_dir", `(\S+)`},
		providers.FlagContext:        {"max_model_len", `(\d+)`},
		providers.FlagTensorParallel: {"tensor_parallel", `(\d+)`},
		providers.FlagQuantization:   {"quantization", `(\S+)`},
		providers.FlagMemory:         {"gpu_memory_utilization", `([\d.]+)`},
	} {
		if flag := p.ServerFlags[field]; flag != "" {
			out[spec.name] = flagAt(flag, spec.value)
		}
	}
	patterns[p.Key] = out
	return out
}

// anyServer matches a field under whichever server engine's spelling, for
// the readers that do not know which engine a cmd is for.
func anyServer(field, value string) *regexp.Regexp {
	seen := map[string]bool{}
	var alts []string
	for _, p := range providers.All() {
		if flag := p.ServerFlags[field]; p.Form == providers.FormServer && flag != "" && !seen[flag] {
			seen[flag] = true
			alts = append(alts, regexp.QuoteMeta(flag))
		}
	}
	sort.Strings(alts)
	return regexp.MustCompile(`(?:^|\s)(?:` + strings.Join(alts, "|") + `)\s+` + value)
}

var (
	anyModelDir = anyServer(providers.FlagModel, `(\S+)`)
	anyContext  = anyServer(providers.FlagContext, `(\d+)`)
)

// BuildServerCmd is the command line for one server engine's entry.
func BuildServerCmd(p providers.Provider, id, modelDir string, maxLen, tp int, util float64, quant, extra, wrapper string) string {
	f := p.ServerFlags
	lines := []string{wrapper, f[providers.FlagModel] + " " + cmdPath(modelDir),
		f[providers.FlagServedName] + " " + id, "--host 127.0.0.1 --port ${PORT}"}
	if maxLen > 0 {
		lines = append(lines, fmt.Sprintf("%s %d", f[providers.FlagContext], maxLen))
	}
	if flag := f[providers.FlagTensorParallel]; tp > 1 && flag != "" {
		lines = append(lines, fmt.Sprintf("%s %d", flag, tp))
	}
	if flag := f[providers.FlagMemory]; util > 0 && flag != "" {
		lines = append(lines, flag+" "+strconv.FormatFloat(util, 'g', 3, 64))
	}
	if flag := f[providers.FlagQuantization]; quant != "" && flag != "" {
		lines = append(lines, flag+" "+quant)
	}
	for _, line := range strings.Split(strings.TrimSpace(extra), "\n") {
		if t := strings.TrimSpace(line); t != "" {
			lines = append(lines, t)
		}
	}
	return strings.Join(lines, "\n") + "\n"
}

// ProviderOf is which provider an entry's launcher belongs to, and whether
// that launcher is a container this console wrote. A macro no record
// claims -- llama-sycl, a native build somebody registered -- is llama.cpp
// run natively, which is what every entry was before there was a choice.
func ProviderOf(cmd string) (p providers.Provider, vendor string, managed bool) {
	macro := strings.TrimSuffix(strings.TrimPrefix(WrapperIn(cmd), "${"), "}")
	if p, vendor, ok := providers.Resolve(macro); ok {
		return p, vendor, true
	}
	return *providers.Get(providers.LlamaCpp), "", false
}

// tensorParallel is how many cards an entry's selector names: the value
// vLLM's --tensor-parallel-size has to agree with. Zero when the entry
// names no card, which leaves the flag to the caller.
func tensorParallel(env map[string]string) int {
	for _, value := range env {
		// level_zero:0,1 and a bare 0,1: a selector is the only value
		// shaped like a list of device numbers.
		if m := deviceList.FindStringSubmatch(value); m != nil {
			return len(strings.Split(m[1], ","))
		}
	}
	return 0
}

var deviceList = regexp.MustCompile(`^(?:[A-Za-z_]+:)?(\d+(?:,\d+)*)$`)

// containerName is the container an entry's launcher runs as, unique per
// entry so two models started through one launcher do not collide on the
// name the script gives them by default.
func containerName(macro, id string) string {
	safe := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.' {
			return r
		}
		return '-'
	}, id)
	return macro + "-" + safe
}

// dirsInCmd is every model flag that names a directory rather than a GGUF:
// the weights of a server engine's entry, one directory as Hugging Face
// publishes it.
func dirsInCmd(cmd string) []string {
	var out []string
	for _, m := range anyModelDir.FindAllStringSubmatch(cmd, -1) {
		name := strings.TrimRight(relativeName(m[1]), "/")
		if strings.HasSuffix(strings.ToLower(name), ".gguf") || name == "" || name == "." {
			continue
		}
		out = append(out, name)
	}
	return out
}

// precisionOf reads what a safetensors model is stored as, from its
// config.json. A publisher's quantisation is recorded there under
// quantization_config, and vLLM applies it on its own; asking for online
// quantisation on top would be refused or wrong. Everything else is the
// dtype the weights were saved in.
func precisionOf(dir string) (precision string, quantized bool) {
	raw, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		return "", false
	}
	var cfg struct {
		TorchDtype string `json:"torch_dtype"`
		Dtype      string `json:"dtype"`
		// A multimodal model keeps the language model's config nested.
		Text struct {
			TorchDtype string `json:"torch_dtype"`
			Dtype      string `json:"dtype"`
		} `json:"text_config"`
		Quant struct {
			Method string `json:"quant_method"`
			Bits   int    `json:"bits"`
			// compressed-tensors: the first group's weight scheme.
			Groups map[string]struct {
				Weights struct {
					Type    string `json:"type"`
					NumBits int    `json:"num_bits"`
				} `json:"weights"`
			} `json:"config_groups"`
		} `json:"quantization_config"`
	}
	if json.Unmarshal(raw, &cfg) != nil {
		return "", false
	}
	if q := cfg.Quant; q.Method != "" {
		switch q.Method {
		case "fp8":
			return "fp8", true
		case "awq", "gptq":
			return q.Method, true
		case "mxfp4":
			return "mxfp4", true
		case "compressed-tensors":
			for _, g := range q.Groups {
				if g.Weights.Type == "float" && g.Weights.NumBits == 8 {
					return "fp8", true
				}
				if g.Weights.NumBits == 4 {
					return "int4", true
				}
				if g.Weights.NumBits == 8 {
					return "int8", true
				}
			}
			return "compressed", true
		}
		if q.Bits == 4 {
			return "int4", true
		}
		return q.Method, true
	}
	dtype := cfg.TorchDtype
	for _, alt := range []string{cfg.Dtype, cfg.Text.TorchDtype, cfg.Text.Dtype} {
		if dtype == "" {
			dtype = alt
		}
	}
	switch dtype {
	case "bfloat16":
		return "bf16", false
	case "float16":
		return "fp16", false
	case "float32":
		return "fp32", false
	}
	return dtype, false
}

// architectureOf is the model class a safetensors directory declares.
func architectureOf(dir string) string {
	raw, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		return ""
	}
	var cfg struct {
		Architectures []string `json:"architectures"`
	}
	if json.Unmarshal(raw, &cfg) != nil || len(cfg.Architectures) == 0 {
		return ""
	}
	return cfg.Architectures[0]
}

// seesImages says whether an architecture takes images: the multimodal
// classes are named for it, one way or another.
func seesImages(architecture string) bool {
	for _, mark := range []string{"ConditionalGeneration", "VL", "Vision", "Omni", "Image"} {
		if strings.Contains(architecture, mark) {
			return true
		}
	}
	return false
}
