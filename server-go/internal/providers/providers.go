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

import "fmt"

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
	macroPrefix:   "llama-",
	scriptPrefix:  "llama-server-",
}

// All is every provider, in the order the store shows them.
func All() []Provider { return []Provider{llamacpp} }

func Get(key string) *Provider {
	for _, p := range All() {
		if p.Key == key {
			return &p
		}
	}
	return nil
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
