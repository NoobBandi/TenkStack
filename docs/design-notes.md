# Design notes

Why TenkStack is built the way it is. Each note is a decision that is easy to
undo by accident, with what was measured or broken that led to it.

## How the pieces fit

```
Caddy ──┬── :8443 https  console (UI + API + /v1 proxy)
        ├── :8000 http   /v1 only, for clients that cannot trust a private CA
        └── :8444 https  ComfyUI, gated by forward_auth against the console
                │
        tenkstack :8070 ┬── llama-swap :8080 ──> one server per loaded model:
                        │                        llama-server (a native build, or
                        │                        the vendor's image in a container),
                        │                        vLLM or SGLang (the vendor's image
                        │                        in a container)
                        ├── ComfyUI :8188+, one container per GPU
                        ├── SearXNG :8090, what the agent's searches go through
                        ├── the agent's Python: a gVisor container per
                        │   conversation, no network
                        └── PostgreSQL, a container reached only by unix socket
```

Everything except Caddy binds to loopback, so the network cannot bypass
authentication. ComfyUI has no auth of its own; publishing it on `0.0.0.0`
would hand the GPU to anyone who can reach the host. (Loopback is not a
boundary between users of the same machine; [SECURITY.md](../SECURITY.md) says
what that means.)

The backend is deliberately thin. llama-swap owns model lifecycle and ComfyUI
owns image generation; this process exists to merge their state with the GPU
telemetry neither can produce on Intel, to own the jobs none of them does at
all (downloads, accounts, installing engines), and to serve the result over
one SSE stream.

## Model configuration is `llama-swap`'s `config.yaml`

There is no management API for adding models, but there is `-watch-config`, so
the file *is* the interface — for every engine, since a vLLM or SGLang entry
is a llama-swap model like any other, its command a launcher macro followed by
one flag per line. The file is read into a `gopkg.in/yaml.v3` node tree and
written back from it (`internal/llamaswap/config.go`), not decoded into
structs: the file carries comments explaining the VRAM policy, and a struct
round-trip would delete every one of them on the first edit made through the
UI. yaml.v3 keeps comments, order and block scalars but drops a blank line
that touches no comment, so blank lines are turned into marker comments before
parsing and back afterwards. The new file replaces the old one by rename, so
llama-swap never reads half of it.

Valid YAML is not enough, though, and finding that out cost an afternoon: a
file that is valid YAML but the wrong shape makes llama-swap log one warning
and keep serving the config it read last, so every edit through the console
appears to work and none of them apply. Only llama-swap knows its own schema,
so it is asked: the write is bracketed by a cursor into llama-swap's user
journal (the console reads the unit the installer writes and the name older
installs used), and a config it reports it will not take is rolled back rather
than left in place. When no verdict arrives within ten seconds — the journal
cannot be read, say — the new file stays.

## Downloads are segmented

A single TCP stream to Hugging Face's Xet CDN measured ~8 MiB/s from Taiwan
(60 ms RTT, heavy packet reordering); eight streams to the *same* endpoint
reached 41 MiB/s. The limit is the bandwidth-delay product of one connection,
not the server or the link.

## Speed is estimated from the header, not from the file size

Hugging Face serves ranged requests on GGUF files, and a GGUF opens with a
complete description of itself: the architecture metadata, then a directory
naming every tensor with its shape and quantisation type. Eight megabytes of a
twenty gigabyte file is enough to answer how fast it would run, because
generation is bandwidth-bound — bytes read per token over what the card
delivers, plus a fixed cost per block. Two details separate that from `size /
bandwidth`, and both are counted from the tensor names: a mixture-of-experts
model reads a fraction of itself (Qwen3-30B-A3B Q4_K_M is 17.3 GiB of file but
1.95 GiB of reading, since 8 of its 128 experts run per token), and a hybrid
model caches on a minority of its layers (Qwen3.8-27B declares 65 blocks; 17
of them hold a KV cache). The constants are measured on this card — 568 GB/s
from the Q6_K mat-vec kernel, 9.8 ms per token of launch overhead — which
matters because the B70 will not report its own memory bandwidth to anything:
`xpu-smi` answers with a −1 sentinel and Level Zero answers 64-bit at 2800
MHz, off by an order of magnitude. The estimate lands on the model measured
here to within 0.3%; where a file is known to break the assumption, the row
says so instead of carrying a correction factor.

## A card's job is derived, never stored

Whether a card can run a llama.cpp model is whether a configured launcher
enumerates it — asked by running `llama-server --list-devices`, not by
consulting a table. Whether it draws images is whether a container bound to it
is up, and which card a container holds is read from its device bindings
rather than from its name, since `--device /dev/dri/by-path/…` and a CUDA
ordinal are facts while `comfyui-nv0` is a convention somebody can rename. So
there is no settings file to fall out of step, and a host with one vendor, or
three, needs nothing edited.

## The VRAM policy asks which card, not device 0

One 32 GB card shared between a language model and ComfyUI needs an arbiter,
and the console is the only process that sees both. With a second card that
arbitration has to know where the model is going: it reads the card from the
model entry's own selector, measures free memory on that card, and matches
ComfyUI instances to cards through the container publishing the port each
answers on — an exact join, where comparing the device names two cards of the
same model report cannot be one.

## A second vendor is an image, not a second toolchain

The native SYCL build is worth keeping for the card whose owner is measuring
it; for every other card the goal is that it works without anyone installing a
10 GB toolchain, which is what llama.cpp's per-backend images are for. The
kernel driver has to be on the host and cannot be anywhere else; everything
above it belongs in the image.

## Capabilities are measured, not declared

Vision support is read from llama-server's `/props`, because a `--mmproj` flag
pointing at a missing file still appears on the command line. Stopped models
fall back to what the config declares, and the response says which of the two
it is. A vLLM or SGLang model has no `/props`; what it takes is read from the
folder's own `config.json`.

## A sandboxed frame has no origin

The frames that run code carry `sandbox="allow-scripts"` and deliberately not
`allow-same-origin`, so their origin is opaque and every request they make
arrives with `Origin: null`. That one fact decides two designs: the agent's
web search runs on the server, because almost nothing accepts that origin, and
the CJK font matplotlib needs is served from a route outside `/api` with a
wildcard — the one thing here that reveals nothing by being readable from
anywhere. Messages from a frame are checked with `event.source ===
frame.contentWindow`, never `event.origin`, which is `"null"` for any
sandboxed frame including a hostile one.

## The agent's Python runs on the server when it can, under gVisor

Each conversation gets a container started with `--runtime=runsc`, no network,
no mounts, a read-only root, two size-capped tmpfs and a memory, CPU and
process limit; the code travels on stdin to a kernel inside it, never into
docker's arguments. gVisor is the boundary: its sentry answers the system
calls itself, so the host kernel -- which also holds the GPUs and every model
-- is not what generated code talks to. The kernel keeps one namespace for the
conversation, so variables and files survive between calls; a call past the
time limit gets SIGINT and keeps them, and only one that ignores it costs the
container. Without runsc nothing runs on the server at all and the chat falls
back to Pyodide in the browser: the plain Docker runtime is not offered as a
weaker alternative. The image is built here from `internal/sandbox/image`,
tagged by a hash of those files, from 設定 → 對話 → Python 沙箱.

## The documents injected into those frames are checked before every build

They are template literals, so an escape written the ordinary way arrives
changed: `\b` became a backspace inside a regex, and a joined `\n` became a
real newline that left an unterminated string. Neither is visible in the
source, because the source is valid JavaScript either way — the mistake exists
only in the string the browser is handed, which is where `pnpm check:frames`
looks.

## Numbers come from the source that owns them

Throughput is llama-server's own `timings`, not tokens divided by browser
wall-clock, which would include network and queue time. vLLM and SGLang report
nothing per request, so for them the reply is measured on its way through the
console's proxy, from the token counts the engine is asked to put on every
chunk — counting chunks instead would read a third of the real rate under
speculative decoding. Time-to-first-token is measured in the browser, because
that is the thing the user actually waits for.