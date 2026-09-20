package llamaswap

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/NoobBandi/TenkStack/server-go/internal/providers"
)

// A vLLM entry has the same shape as a llama.cpp one -- the launcher macro
// on the first line, one flag per line under it -- so everything that
// reads a cmd (which launcher, which card, which files) works on both. The
// flags are vLLM's own: --max-model-len where llama.cpp says --ctx-size,
// --tensor-parallel-size for a model across cards, and no layer count
// because vLLM either fits or does not.
//
// --served-model-name is the entry's id. llama-swap forwards the request
// body as the client sent it, and vLLM refuses a request whose model field
// names anything but a name it was started with.

var vllmPatterns = map[string]*regexp.Regexp{
	"model_dir":              regexp.MustCompile(`--model\s+(?:\$\{[^}]+\}/)?(\S+)`),
	"max_model_len":          regexp.MustCompile(`--max-model-len\s+(\d+)`),
	"tensor_parallel":        regexp.MustCompile(`--tensor-parallel-size\s+(\d+)`),
	"quantization":           regexp.MustCompile(`--quantization\s+(\S+)`),
	"gpu_memory_utilization": regexp.MustCompile(`--gpu-memory-utilization\s+([\d.]+)`),
}

// BuildVLLMCmd is the command line for one vLLM entry.
func BuildVLLMCmd(id, modelDir string, maxLen, tp int, util float64, quant, extra, wrapper string) string {
	lines := []string{wrapper, "--model ${models-dir}/" + modelDir, "--served-model-name " + id, "--host 127.0.0.1 --port ${PORT}"}
	if maxLen > 0 {
		lines = append(lines, fmt.Sprintf("--max-model-len %d", maxLen))
	}
	if tp > 1 {
		lines = append(lines, fmt.Sprintf("--tensor-parallel-size %d", tp))
	}
	if util > 0 {
		lines = append(lines, "--gpu-memory-utilization "+strconv.FormatFloat(util, 'g', 3, 64))
	}
	if quant != "" {
		lines = append(lines, "--quantization "+quant)
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

// dirsInCmd is every --model that names a directory rather than a GGUF:
// the weights of a vLLM entry, one directory as Hugging Face publishes it.
func dirsInCmd(cmd string) []string {
	var out []string
	for _, m := range vllmPatterns["model_dir"].FindAllStringSubmatch(cmd, -1) {
		name := strings.TrimRight(m[1], "/")
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
		Quant      struct {
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
	if dtype == "" {
		dtype = cfg.Dtype
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
