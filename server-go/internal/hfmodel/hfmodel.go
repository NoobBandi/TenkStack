// Package hfmodel reads what a model's config.json says about it, as
// Hugging Face publishes a model: its class, how its weights are stored,
// whether it takes images, how long a context it was built for. The model
// page reads it from a directory on disk, the catalog from the repository
// before anything is downloaded, so both say the same thing.
package hfmodel

import (
	"encoding/json"
	"strings"
)

// Config is what the model page and the catalog show about a model.
type Config struct {
	Architecture string
	// Precision is how the weights are stored: bf16, fp16, fp32, or a
	// publisher's quantisation (fp8, awq, gptq, int4, int8, mxfp4, …).
	Precision string
	// Quantized: the publisher quantised it, and the engine applies that
	// on its own; online quantisation on top would be refused or wrong.
	Quantized bool
	// Vision: it takes images.
	Vision bool
	// ContextLength is the context it was trained for, 0 when unsaid.
	ContextLength int
	// Layers is the language model's layer count, 0 when unsaid.
	Layers int
	// MTP: the weights carry a multi-token prediction head, which an engine
	// can use to draft several tokens at once.
	MTP bool
}

type textConfig struct {
	TorchDtype   string `json:"torch_dtype"`
	Dtype        string `json:"dtype"`
	MaxPositions int    `json:"max_position_embeddings"`
	HiddenLayers int    `json:"num_hidden_layers"`
	MTPLayers    int    `json:"mtp_num_hidden_layers"`
	NextNLayers  int    `json:"num_nextn_predict_layers"`
}

// Parse reads a config.json. A file that is not one gives the zero Config.
func Parse(raw []byte) Config {
	var cfg struct {
		Architectures []string `json:"architectures"`
		textConfig
		// A multimodal model keeps the language model's config nested.
		Text   textConfig      `json:"text_config"`
		Vision json.RawMessage `json:"vision_config"`
		Quant  struct {
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
		return Config{}
	}
	out := Config{}
	if len(cfg.Architectures) > 0 {
		out.Architecture = cfg.Architectures[0]
	}
	out.Vision = (len(cfg.Vision) > 0 && string(cfg.Vision) != "null") || SeesImages(out.Architecture)
	out.ContextLength = cfg.MaxPositions
	if out.ContextLength == 0 {
		out.ContextLength = cfg.Text.MaxPositions
	}
	out.MTP = cfg.MTPLayers+cfg.NextNLayers+cfg.Text.MTPLayers+cfg.Text.NextNLayers > 0
	out.Layers = cfg.HiddenLayers
	if out.Layers == 0 {
		out.Layers = cfg.Text.HiddenLayers
	}
	if q := cfg.Quant; q.Method != "" {
		out.Quantized = true
		switch q.Method {
		case "fp8", "awq", "gptq", "mxfp4":
			out.Precision = q.Method
		case "compressed-tensors":
			out.Precision = compressedScheme(q.Groups)
		default:
			out.Precision = q.Method
			if q.Bits == 4 {
				out.Precision = "int4"
			}
		}
		return out
	}
	dtype := cfg.TorchDtype
	for _, alt := range []string{cfg.Dtype, cfg.Text.TorchDtype, cfg.Text.Dtype} {
		if dtype == "" {
			dtype = alt
		}
	}
	switch dtype {
	case "bfloat16":
		out.Precision = "bf16"
	case "float16":
		out.Precision = "fp16"
	case "float32":
		out.Precision = "fp32"
	default:
		out.Precision = dtype
	}
	return out
}

// compressedScheme names a compressed-tensors model by the first group
// whose weight scheme is one of the known ones.
func compressedScheme(groups map[string]struct {
	Weights struct {
		Type    string `json:"type"`
		NumBits int    `json:"num_bits"`
	} `json:"weights"`
}) string {
	for _, g := range groups {
		switch {
		case g.Weights.Type == "float" && g.Weights.NumBits == 8:
			return "fp8"
		case g.Weights.NumBits == 4:
			return "int4"
		case g.Weights.NumBits == 8:
			return "int8"
		}
	}
	return "compressed"
}

// SeesImages says whether an architecture takes images: the multimodal
// classes are named for it, one way or another.
func SeesImages(architecture string) bool {
	for _, mark := range []string{"ConditionalGeneration", "VL", "Vision", "Omni", "Image"} {
		if strings.Contains(architecture, mark) {
			return true
		}
	}
	return false
}
