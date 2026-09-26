# Inference engines

Every inference engine the console can install is one directory here:

```
engines/
  llamacpp/   engine.yaml  icon.svg
  vllm/       engine.yaml  icon.png
  sglang/     engine.yaml  icon.png
```

The directories are compiled into the console. An engine added here shows up
on the 推論引擎 page, can be installed on the cards it has a build for, and
its models are edited and launched with nothing else in the code changed. The
tests in `internal/providers` refuse a record that is incomplete or
contradicts itself, and they say why.

## engine.yaml

```yaml
key: sglang                 # the directory's name: lower case letters and digits
name: SGLang
order: 20                   # place in the store; the default engine comes first
default: false              # exactly one engine is the default (llama.cpp)
program: sglang serve       # for the launcher script's header
summary: 多人同時對話、長對話……  # the one line a newcomer reads to choose (Chinese, like the UI)
category: llm
formats: [safetensors]      # gguf and/or safetensors
site: https://github.com/sgl-project/sglang
icon: icon.png              # beside this file: svg, png or webp, under 64 KB
icon_source: https://…      # where the icon came from

form: server                # llama (llama.cpp's form) or server (see below)
flags:                      # server engines: how this engine spells each field
  model: --model-path
  served_name: --served-model-name
  context: --context-length
  tensor_parallel: --tp-size          # optional
  memory: --mem-fraction-static       # optional
  quantization: --quantization        # optional
drop_max_tokens: true       # the proxy leaves max_tokens out of requests
tools: true                 # entries declare tool calling

sampling:                   # the chat panel's controls, as this engine names them
  temperature: temperature  # a control left out is hidden in the chat and not sent;
  repeat_penalty: repetition_penalty   # no `sampling` at all means llama-server's names
  # top_p, top_k, min_p, presence_penalty, frequency_penalty, seed, reasoning_budget_tokens
speculation:                # optional: an entry whose command has `flag` refuses these,
  flag: --speculative-config  # so the chat hides them and the proxy drops them
  refuses: [min_p, logit_bias]

env_prefix: SGLANG          # <PREFIX>_IMAGE and <PREFIX>_NAME in the launcher

builds:                     # one per vendor key in internal/vendors
  intel:
    image: lmsysorg/sglang:v0.5.20-xpu
    verified: false         # true only once it has run on that vendor's card
    requires: …             # something the host needs first, shown before the download
    flags: [--device, /dev/dri, --ipc, host]   # docker run flags that hand over the cards
    command: [sglang, serve, --device, xpu]    # run inside the image before llama-swap's flags
    cache_dir: /root/.cache/…                  # kept on the host between runs

online_quantization:        # applied to bf16 weights while they load
  - {value: fp8, label: FP8（線上量化）, note: 顯存減半, shrink: 0.5}

recommended:                # flags a model family needs, offered when its folder is picked
  - match: ^Qwen3           # regular expression against config.json's architecture
    flags: [--reasoning-parser qwen3]
    note: 思考過程與工具呼叫分開回傳
  - match: ^Qwen3_5
    vendors: [intel]        # optional: only for these vendors' builds
    flags: [--max-num-seqs 4]
```

The first matching rule wins for each flag name. A rule that works around one
vendor's image names that vendor under `vendors`, so the same engine on
another vendor's card keeps its own defaults; a rule about the model itself
(its tool-call format, its reasoning parser) names none.

`fallback` (llama.cpp only so far) is a build that runs on any vendor's card,
offered as a variant: `label`, `image`, `requires`, `flags`.

`macro_prefix` and `script_prefix` exist only for names llama.cpp had before
this registry. A new engine leaves them out, and its launcher is the macro
`<key>-<vendor>` and the script `<key>-<vendor>.sh`.

### Two YAML traps

- In a flow list, a comma splits an item: `[-e, A=b,c]` is three items. Quote
  anything with a comma: `[-e, "A=b,c"]`.
- `--flag value` inside `flags` is two items, not one: `[--shm-size, 16g]`.

## Forms

**llama** is llama.cpp's: a GGUF file, layers on the card, a vision projector,
sampling. The console reads `/props` and `/slots` from a running server of
this form.

**server** is an OpenAI-compatible server of one directory of weights, the
way Hugging Face publishes a model: a context length, a card count, a memory
share and a quantisation. vLLM and SGLang are this form, and most new engines
will be. The console writes one flag per line under the launcher macro, using
the spellings in `flags`, and reads them back the same way, so an entry
survives an edit. The served-name flag carries the entry's id, because the
server refuses a request whose `model` field names anything else.

An engine that fits neither form is a code change, not only a record: open an
issue first.

## Before a pull request

1. `go test ./internal/providers ./internal/llamaswap ./internal/backends`.
2. Install it from the 推論引擎 page on a real card, create a model entry for
   it on the 模型 page, load it and chat with it.
3. Report what you ran: the card, the model, its precision and context, and
   tokens per second. Set `verified: true` on that vendor's build in the same
   pull request, and only on that one.
