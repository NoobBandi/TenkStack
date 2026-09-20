// Package providers is the registry of inference software the console can
// install: what each one is, which model formats it serves, and the
// container image that drives it on each vendor's cards.
//
// A vendor record (internal/vendors) says how a card is reached -- the
// device flags, the selector variable, how a container declares it. A
// provider record says what runs on that card. The two are separate because
// the relation is many to many: one card can be served by llama.cpp and by
// vLLM, and each of those ships an image per vendor. Before this package
// the llama.cpp image sat on the vendor record, which was fine while
// llama.cpp was the only thing that ran a model and stopped being fine the
// moment there was a second.
//
// The records are compiled in. They are plain data, so a registry fetched
// from the project's repository later can replace them without changing
// anything that reads them.
package providers

import (
	"fmt"

	"github.com/NoobBandi/TenkStack/server-go/internal/vendors"
)

// Build is one provider's container image for one vendor's cards, and what
// running it needs of the host.
type Build struct {
	Image string
	// Requires names something the host must already have, so the UI can
	// say it before a multi-gigabyte download.
	Requires string
	// Verified is false for a recipe written from documentation and never
	// run here.
	Verified bool
	// Flags are the docker run arguments that hand the cards over. Empty
	// means the vendor's own passthrough for the whole machine.
	Flags []string
	// Command is what the launcher runs inside the image before the flags
	// llama-swap passes. Empty for an image whose entrypoint is the server.
	Command []string
	// CacheDir is where the image keeps compiled kernels between runs, to
	// be mounted from the host so a restart does not compile again.
	CacheDir string
}

// Quant is one quantisation a provider can apply to plain weights as it
// loads them. Shrink is the weights' footprint against bf16.
type Quant struct {
	Value string
	Label string
	// Note is what it costs and saves, for the help under the field.
	Note   string
	Shrink float64
}

// Provider is one piece of inference software.
type Provider struct {
	Key  string
	Name string
	// Program is the process the launcher starts, for the script's header.
	Program string
	// Summary is the one line a newcomer reads to choose.
	Summary  string
	Category string // llm
	// Formats are the model file formats it serves: gguf, safetensors.
	Formats []string
	Site    string
	// Builds by vendor key. A vendor with no build has no way to run this
	// provider on its cards, and the store does not offer it there.
	Builds map[string]Build
	// Fallback is a build that runs on any vendor's card, offered as a
	// variant rather than a default: it is slower and needs something of
	// the host the vendor build does not.
	Fallback      *Build
	FallbackLabel string
	// EnvPrefix names the launcher's own variables: <PREFIX>_IMAGE overrides
	// the image, <PREFIX>_NAME the container name.
	EnvPrefix string
	// ModelFlag names the weights: --model for both, but read from the
	// record rather than assumed.
	ModelFlag string
	// Flags the console's own form writes for this provider, so an entry
	// read back can tell its fields from what the user typed by hand.
	Managed []string
	// Online are the quantisations worth offering for a model published in
	// bf16. The image is asked which of them it actually has.
	Online []Quant

	// The macro and script names llama.cpp had before this package existed,
	// kept so a config written then still resolves. Empty means the key.
	macroPrefix  string
	scriptPrefix string
}

// Macro is the llama-swap macro naming this provider's launcher for one
// vendor: llama-intel, vllm-intel.
func (p Provider) Macro(vendor string) string {
	prefix := p.macroPrefix
	if prefix == "" {
		prefix = p.Key + "-"
	}
	return prefix + vendor
}

// ScriptName is the launcher script's file name for one vendor.
func (p Provider) ScriptName(vendor string) string {
	prefix := p.scriptPrefix
	if prefix == "" {
		prefix = p.Key + "-"
	}
	return prefix + vendor + ".sh"
}

// Serves says whether the provider runs models in this format.
func (p Provider) Serves(format string) bool {
	for _, f := range p.Formats {
		if f == format {
			return true
		}
	}
	return false
}

const (
	LlamaCpp = "llamacpp"
	VLLM     = "vllm"
)

var llamacpp = Provider{
	Key: LlamaCpp, Name: "llama.cpp", Program: "llama-server",
	Summary:  "GGUF 模型的標準執行環境，任何顯示卡都能跑，也能把一部分放到 CPU 上",
	Category: "llm",
	Formats:  []string{"gguf"},
	Site:     "https://github.com/ggml-org/llama.cpp",
	Builds: map[string]Build{
		"intel":  {Image: "ghcr.io/ggml-org/llama.cpp:server-intel"},
		"amd":    {Image: "ghcr.io/ggml-org/llama.cpp:server-rocm"},
		"nvidia": {Image: "ghcr.io/ggml-org/llama.cpp:server-cuda", Requires: "nvidia-container-toolkit", Verified: true},
	},
	// Deliberately not a default: one tenth the size and runs on any
	// vendor, but needs a Vulkan ICD on the host, which a compute-only
	// NVIDIA install has not got.
	Fallback: &Build{
		Image:    "ghcr.io/ggml-org/llama.cpp:server-vulkan",
		Flags:    []string{"--device", "/dev/dri", "--gpus", "all", "-e", "NVIDIA_DRIVER_CAPABILITIES=graphics,compute,utility"},
		Requires: "vulkan ICD",
	},
	FallbackLabel: "Vulkan（通用備援）",
	EnvPrefix:     "LLAMA",
	ModelFlag:     "--model",
	macroPrefix:   "llama-",
	scriptPrefix:  "llama-server-",
}

// vLLM serves safetensors as Hugging Face publishes them, FP16 with online
// FP8 or INT4 on request, and pre-allocates the card: a vLLM entry belongs
// in the exclusive group. The Intel image is the one the llm-scaler
// project publishes for Arc Pro B-series cards; its entrypoint sources
// oneAPI and runs `vllm serve`, so the flags go straight to it.
var vllm = Provider{
	Key: VLLM, Name: "vLLM", Program: "vllm serve",
	Summary:  "高吞吐的推論伺服器，直接跑 Hugging Face 的 safetensors 模型，多人同時使用時最快",
	Category: "llm",
	Formats:  []string{"safetensors"},
	Site:     "https://github.com/vllm-project/vllm",
	Builds: map[string]Build{
		"intel": {
			Image: "intel/llm-scaler-vllm:0.26.0-b2",
			// Workers move tensors through shared memory, and Docker's
			// default 64 MB is too small for a model of any size. OneCCL
			// scans /dev/dri/by-path to pair cards, and --device hands
			// over the nodes without that directory. Offline because the
			// weights are local: a name that is not a path must not turn
			// into a download inside the container.
			Flags: []string{"--device", "/dev/dri", "-v", "/dev/dri/by-path:/dev/dri/by-path:ro",
				"--shm-size", "16g", "-e", "HF_HUB_OFFLINE=1"},
			// torch.compile takes half a minute per start without it.
			CacheDir: "/root/.cache/vllm",
			Verified: true,
		},
		"nvidia": {
			Image: "vllm/vllm-openai:latest", Requires: "nvidia-container-toolkit",
			Flags:    []string{"--gpus", "all", "--ipc", "host", "-e", "HF_HUB_OFFLINE=1"},
			CacheDir: "/root/.cache/vllm",
		},
		"amd": {
			Image: "rocm/vllm:latest",
			Flags: []string{"--device", "/dev/dri", "--device", "/dev/kfd", "--group-add", "video",
				"--security-opt", "seccomp=unconfined", "--ipc", "host", "-e", "HF_HUB_OFFLINE=1"},
			// The ROCm image drops into a shell.
			Command:  []string{"vllm", "serve"},
			CacheDir: "/root/.cache/vllm",
		},
	},
	EnvPrefix: "VLLM",
	ModelFlag: "--model",
	Managed: []string{"--model", "--served-model-name", "--host", "--port", "--max-model-len",
		"--tensor-parallel-size", "--gpu-memory-utilization", "--quantization"},
	// The rest of vLLM's list names checkpoint formats -- awq, gptq,
	// compressed-tensors -- which a repo declares in its config.json and
	// vLLM applies unasked. These two are the ones that take bf16 weights
	// and compress them on the way in.
	Online: []Quant{
		{Value: "fp8", Label: "FP8（線上量化）", Note: "顯存減半，品質幾乎不變", Shrink: 0.5},
		{Value: "sym_int4", Label: "Int4（線上量化）", Note: "顯存四分之一，品質略降", Shrink: 0.25},
	},
}

// All is every provider, in the order the store shows them.
func All() []Provider { return []Provider{llamacpp, vllm} }

func Get(key string) *Provider {
	for _, p := range All() {
		if p.Key == key {
			return &p
		}
	}
	return nil
}

// Resolve is the provider and vendor a launcher macro names, for a macro
// this console wrote: llama-nvidia, vllm-intel. A macro that matches no
// record -- a native build somebody registered by hand -- is nobody's.
func Resolve(macro string) (Provider, string, bool) {
	for _, p := range All() {
		for _, v := range vendors.All() {
			if p.Macro(v.Key) == macro {
				return p, v.Key, true
			}
		}
	}
	return Provider{}, "", false
}

// Unknown is the error for a key no record has.
type Unknown struct{ Key string }

func (e *Unknown) Error() string { return fmt.Sprintf("沒有叫 %s 的執行環境", e.Key) }

// Lookup is Get with an error for the handler to return.
func Lookup(key string) (Provider, error) {
	if p := Get(key); p != nil {
		return *p, nil
	}
	return Provider{}, &Unknown{key}
}
