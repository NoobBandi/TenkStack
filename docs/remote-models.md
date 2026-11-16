# Models on another machine

The console starts and supervises the engines it knows (llama.cpp, vLLM,
SGLang) on the cards of this machine. A model served by a machine it does
not run — a Mac running [Yunshu](https://github.com/YuhuanStudio/Yunshu),
a second box, a friend's server — can still be used through the console's
`/v1` by writing one entry into llama-swap's `config.yaml` by hand. The
console preserves hand-written entries when it writes the file
(`internal/llamaswap` reads and writes it without losing what a person
wrote), and as of the change this document ships with it never frees or waits on ComfyUI
to "make room" for such an entry, and never polls it as llama-server.

## The entry

llama-swap requires a `cmd` on every entry, so the entry hangs its
lifecycle on a placeholder and points its `proxy` at the other machine:

```yaml
models:
  mac-qwen:
    name: Qwen3.4B on the Mac
    cmd: sleep 3600
    proxy: http://192.168.1.30:8000
    useModelName: Qwen3-4B-MLX-4bit
    checkEndpoint: /v1/models
    ttl: 0
    aliases:
      - qwen-mac
```

`proxy` is where every `/v1` request for this id goes; `checkEndpoint`
is what llama-swap probes before forwarding (use `none` to skip it);
`useModelName` is what the server is sent in the `model` field, which
servers that validate it (vLLM, SGLang, Yunshu's single-model mode)
otherwise refuse; the placeholder process is what llama-swap starts,
health-checks and kills on unload, which is why `ttl: 0` is the plain
reading — there is nothing to time out. The console recognises an entry
as remote when its `proxy` is explicit, names something other than a
loopback address, and contains no `${PORT}` or macro; that is what keeps
it out of the card and VRAM arithmetic.

Measured on llama-swap v273 (container image `cpu`, built 2026-11-15)
against a real Mac running Yunshu 0.1.8.dev4 with
`lmstudio-community/Qwen3-4B-MLX-4bit`, through a console on a Linux
box: `GET /v1/models` listed the id and a request by its alias answered
from the Mac; chat answered streaming and not, as did the legacy
`/v1/completions`, Anthropic `/v1/messages` with `count_tokens`, and a
tool-call round trip; unloading the entry killed the placeholder and the
next request health-checked and answered again. Two console accounts
were tried against it — the member was refused the model editor and its
API key worked on `/v1`, while an administrator's key got 403 on `/api`.
The Models page was refreshed for two minutes and the Mac saw nothing.
On the ComfyUI question this was not a GPU machine and ComfyUI was not
running, so the eviction guard is tested by unit tests only there.

## What works and what does not

- Works: the console's `/v1/chat/completions` and `/v1/messages`, the
  chat panel, API keys, the model id appearing in `/v1/models`.
- Not managed: the Engines and Models pages never install, size,
  benchmark, quantise or GPU-place it; the Models page may group it
  under llama.cpp and its load/unload buttons act on the placeholder,
  not on the real server.
- No credential: a model entry cannot send an `Authorization` header.
  Serve the remote endpoint on a network you trust (LAN, Tailscale), or
  bring your own tunnel. llama-swap's `peers` can reach a machine behind
  NAT over a tailcat:// key; that is llama-swap's own feature, not the
  console's.
- One llama-swap quirk to know: because the placeholder "loads" instantly
  and never dies on its own, the Models page shows the entry as loaded
  once anything has referenced it until llama-swap is told to unload it.

## Why this is not "an engine"

`internal/providers/engines/README.md` explains the engine record: an
image, a launcher, cards. A server on another machine has none of those
to manage. The console does not yet have a form for adding these from
the Models page; that is a separate design — until it exists, this file
is the supported way, and it is what anyone porting to a platform the
console's container story does not cover (see the MLX section of
`docs/adding-a-gpu-vendor.md`) should be pointed at first.
