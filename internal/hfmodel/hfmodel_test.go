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

func TestExperts(t *testing.T) {
	moe := Parse([]byte(`{"text_config":{"num_hidden_layers":40,"num_experts":256,"num_experts_per_tok":8}}`))
	if moe.Experts != 256 || moe.ExpertsActive != 8 {
		t.Errorf("Qwen MoE: %+v", moe)
	}
	if ds := Parse([]byte(`{"num_hidden_layers":61,"n_routed_experts":256,"num_experts_per_tok":8}`)); ds.Experts != 256 {
		t.Errorf("DeepSeek: %+v", ds)
	}
	if dense := Parse([]byte(`{"num_hidden_layers":64,"num_experts":0}`)); dense.Experts != 0 {
		t.Errorf("dense: %+v", dense)
	}
}

// Qwen3.8-27B's file sets three samplers; the rest are off, not the panel's.
func TestGeneration(t *testing.T) {
	got := Generation([]byte(`{"do_sample": true, "temperature": 1.0, "top_k": 20, "top_p": 0.95}`))
	want := map[string]any{"temperature": 1.0, "top_k": 20, "top_p": 0.95, "min_p": 0.0, "repeat_penalty": 1.0, "presence_penalty": 0.0}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %v, want %v", k, got[k], v)
		}
	}
	if got := Generation([]byte(`{"bos_token_id": 1, "eos_token_id": 2}`)); got != nil {
		t.Errorf("a file with no sampling should say nothing, got %v", got)
	}
	if got := Generation([]byte(`not json`)); got != nil {
		t.Errorf("garbage should say nothing, got %v", got)
	}
}
