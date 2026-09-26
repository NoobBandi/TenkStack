package hfmodel

import (
	"os"
	"testing"
)

func TestParseQwen38(t *testing.T) {
	raw, err := os.ReadFile("testdata/qwen38-27b-bf16.json")
	if err != nil {
		t.Fatal(err)
	}
	c := Parse(raw)
	if c.Architecture != "Qwen3_5ForConditionalGeneration" || c.Precision != "bf16" || c.Quantized ||
		!c.Vision || !c.MTP || c.ContextLength != 262144 || c.Layers != 64 {
		t.Errorf("%+v", c)
	}
	// 16 of 64 layers attend fully: 2 x 16 x 4 heads x 256 x 2 bytes. vLLM
	// measured 71.3 KiB a token with its MTP layer and padding on top.
	if c.KVBytesPerToken != 64<<10 || !c.Hybrid {
		t.Errorf("kv %d bytes, hybrid %v", c.KVBytesPerToken, c.Hybrid)
	}
}

func TestKVBytes(t *testing.T) {
	for raw, want := range map[string]int64{
		// Llama 3.1 8B: 32 layers, 8 KV heads of 128.
		`{"num_hidden_layers":32,"num_attention_heads":32,"num_key_value_heads":8,"hidden_size":4096}`: 2 * 32 * 8 * 128 * 2,
		// DeepSeek V3: MLA, 61 layers of 512 + 64.
		`{"num_hidden_layers":61,"kv_lora_rank":512,"qk_rope_head_dim":64,"num_attention_heads":128}`: 61 * 576 * 2,
		// Too little said.
		`{"num_hidden_layers":32}`: 0,
	} {
		if got := Parse([]byte(raw)).KVBytesPerToken; got != want {
			t.Errorf("%s: %d, want %d", raw, got, want)
		}
	}
}

func TestParsePrecisions(t *testing.T) {
	for raw, want := range map[string]string{
		`{"torch_dtype":"float16"}`:                                      "fp16",
		`{"quantization_config":{"quant_method":"fp8"}}`:                 "fp8",
		`{"quantization_config":{"quant_method":"awq"}}`:                 "awq",
		`{"quantization_config":{"quant_method":"auto-round","bits":4}}`: "int4",
		`{"quantization_config":{"quant_method":"compressed-tensors","config_groups":{"group_0":{"weights":{"type":"float","num_bits":8}}}}}`: "fp8",
		`{"quantization_config":{"quant_method":"compressed-tensors","config_groups":{"group_0":{"weights":{"type":"int","num_bits":4}}}}}`:   "int4",
	} {
		if got := Parse([]byte(raw)).Precision; got != want {
			t.Errorf("%s: %q, want %q", raw, got, want)
		}
	}
	if c := Parse([]byte(`{"architectures":["LlamaForCausalLM"],"num_nextn_predict_layers":0}`)); c.Vision || c.MTP {
		t.Errorf("a text model without a draft head: %+v", c)
	}
	if c := Parse([]byte("not json")); c != (Config{}) {
		t.Errorf("not a config: %+v", c)
	}
}
