<p align="center">
  <img src="https://cdn.quantdense.com/tenkstack/tenkstack-banner.png"
       alt="TenkStack" width="820">
</p>

# TenkStack

A self-hosted control panel for a machine with one or more GPUs that runs
language models and generates images. It sits on top of
[llama.cpp](https://github.com/ggml-org/llama.cpp) (through
[llama-swap](https://github.com/mostlygeek/llama-swap)) and
[ComfyUI](https://github.com/comfyanonymous/ComfyUI), and adds what neither has:
a dashboard that reads every card, a chat with an agent that can run code and
search, a model catalogue that downloads from Hugging Face, accounts and API
keys, and an OpenAI- and Anthropic-compatible endpoint that Claude Code, Codex
and anything else can point at.

Each card is told what it is for — models, images, both, or nothing — and every
surface reports per card rather than per machine. Intel, NVIDIA and AMD are
three records in `internal/vendors/`; a machine with one vendor or three needs
nothing edited.

It began on an **Intel Arc Pro B70** (Battlemage, 32 GB, the `xe` driver), where
the usual CUDA-shaped tooling does not apply, and that is why the Intel path is
the most thoroughly measured one. An RTX 3060 went in beside it later, which is
when the console learned to keep two vendors apart. It replaced a GPUStack
deployment: GPUStack is built for multi-node clusters, and on one machine every
one of its sharp edges — worker registration, the VRAM estimator, the embedded
gateway — was the cost of an architecture this box does not have.

## Install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/NoobBandi/TenkStack/main/install.sh)
```

Use `bash <(...)` as written, not `curl | bash` — piped, the script cannot ask
you anything. In a terminal it opens setup screens — English or Traditional
Chinese, chosen on the first one — where you pick the install directory, the
inference engines, which cards run ComfyUI, SearXNG and how the console is
reached; without a terminal, or with `--no-tui`, it asks the same as plain
questions. It then shows its plan and waits for a yes before changing the
machine, runs as your user (`sudo` only for packages, groups, the NVIDIA
driver, and the TLS step if you pick one), and never reboots on its own. When
it finishes the console is at `http://<host>:8443`; the first visit registers
the owner account.

How it is reached from other machines is one flag:

| | |
|---|---|
| *(none)* | Plain HTTP on `:8443`. Right when something in front already terminates TLS — Cloudflare Tunnel, Tailscale Serve, an ingress — or on a network you trust. |
| `--tls internal` | HTTPS with Caddy's own CA. For an isolated LAN; each device imports one root certificate. |
| `--tls CERT,KEY` | HTTPS with a certificate you already have. |
| `--domain NAME` | HTTPS with Let's Encrypt, obtained and renewed by Caddy. Needs `:80`/`:443` reachable from the internet. |

The setup screens ask the same thing; the flag only pre-answers it.
Likewise `--searxng` installs [SearXNG](https://github.com/searxng/searxng)
on loopback so the chat's agent can search the web — optional, and the
console offers the model that tool only while an instance answers.

Engines and ComfyUI are installed last, by the console itself once it is up
and before the first account exists: `--engines llamacpp,vllm` and
`--comfyui 0000:0c:00.0` (PCI addresses, as `lspci -D` prints them)
pre-answer those screens. Anything left out, or anything that fails, is
installed later from the console's Engines and ComfyUI pages. On Intel,
ComfyUI needs `xpu-smi` present for the console to see the cards.

Other flags: `--lang en|zh-TW`, `--dir PATH` (default `~/tenkstack`),
`--no-tui`, `--yes`, `--dry-run`, `--help`.

### Uninstall

Run the same command. When an install is found, the first screen after the
language asks whether to install (or update) or to uninstall; the plain
equivalent is `--uninstall`. It stops and removes TenkStack's services, the
containers with a mount under the install directory, their images (unless
`--keep-images`), the xpu-smi journal filter and the trust in Caddy's own CA,
and deletes the programs. The install directory — models, ComfyUI files,
settings, chat history — stays, and installing again picks it up; `--purge`
deletes it too, after you type its path. Packages, groups and linger stay.

Tested on Ubuntu 24.04. NVIDIA drivers are installed when missing; Intel and
AMD cards need the vendor's compute stack already present.

## What it does

- **Dashboard** — one block per GPU: power, VRAM, clock and tokens/sec, live,
  with needle-less gauges for host CPU, memory and disk beside them and a chart
  that switches cards from a dropdown. GPU telemetry comes from `xpu-smi` and
  `nvidia-smi` together, because llama-swap probes only for the latter and
  reports nothing on Intel.
- **Chat** — streaming, with server-measured throughput, context-window usage,
  image attachments and a composer that shades ``` code fences as you type.
  Sampling settings are seeded from the model's own llama-swap entry, so the
  config and the panel cannot disagree.
- **Agent** — the model runs Python to answer, up to eight steps, choosing what
  to do next from what came back, and searches the web the same way. One trace
  above the reply carries the working in the order it happened: each thought,
  each program, its output, its figures, and the pages a search actually read —
  a citation nobody can follow is decoration.
- **Previews** — HTML, SVG, React, Markdown and Python open in a panel beside
  the reply, HTML and Markdown as the document they describe rather than as
  source. React is transpiled in the frame instead of being posted to a compiler
  service; Python is CPython on WebAssembly. Nothing in a frame can reach the
  host, which is what the button is allowed to promise.
- **Models** — add, edit and remove models; optionally delete their weights from
  disk; spot orphaned files and interrupted downloads. One vision projector can
  serve several models, and each entry says which it is using. On a machine
  where more than one card can run a model, an entry also says which card —
  and the field appears only there, because a single usable card is not a
  choice.
- **Catalog** — search Hugging Face and download GGUFs, segmented and resumable,
  into per-repo folders so two publishers' identically named quants stay
  distinct. Split uploads are listed as one model rather than as the fragments
  they arrive in, since no fragment is usable alone. Any quant can be asked what
  it would generate at *on this card* before the download starts, worked out
  from the file's own header.
- **GPU roles** — one row per card with two switches: run models, draw images.
  Neither is a stored preference. The first reads whether a configured
  llama-server can actually enumerate that card, the second whether a container
  bound to it is up, so the page cannot come to disagree with the machine.
  Turning either on for the first time installs what it needs — the official
  llama.cpp image for the vendor, or a ComfyUI instance with its own port,
  storage and Caddy site block — in the background, with a bar.
- **ComfyUI** — for whoever wants a picture: is it free, the button that opens
  it, and the three steps once inside, including where the pictures land. For
  the administrator, below that: the container's CPU, memory, the card as the
  host sees it (so a language model crowding it is named before Run, not after),
  what its directories weigh, maintenance, and how it is built. The newest
  ComfyUI release is looked up hourly with one call; updates run through
  ComfyUI-Manager. The console also seeds the instance's shared user storage
  so the Manager's own "Install via Git URL" works out of the box: it sets
  `allow_git_url_install` and writes the image's `pre-start.sh` hook, which
  drops the Manager's loopback-listener test on every start -- a test that can
  never pass in a container, where ComfyUI must bind 0.0.0.0 and the
  console's login is what actually gates the UI. Remove the
  `# managed by TenkStack` line to take the hook over.
- **Files** — laid out the way a file manager is: locations down the left,
  the path as crumbs, the folder in the middle, and what the selection is on
  the right; opening a text file adds a tab with Monaco underneath. The whole
  disk rather than one application's folders: declared
  roots, a deny list the console cannot be talked out of, and previews for
  images, text, and weights — a GGUF or safetensors header is read in place, so
  a 20 GB file answers what it is without being moved. Uploads are chunked and
  resumable, streamed to disk rather than buffered.
- **Logs** — one stream for every part of the platform: the user units from
  the systemd journal, the ComfyUI containers from `docker logs`. The window
  on screen is read from those stores, so an hour is an hour of history
  whatever the console has been doing, and a week answers in about a second
  because journalctl is asked only for what the units' own processes wrote.
  Sources sit down the left with whether each is being read and how many
  lines it put in the window, which is the answer to "is this being recorded
  at all". The console's own polling of llama-swap and Caddy is flagged and
  hidden by default.
- **Users** — accounts, roles and API keys for the API below.
- **About** — what this is and where it comes from, and whether there is a
  newer one: each installation asks GitHub for the latest release itself, a
  few times a day, and marks the version in the sidebar when there is. The
  administrator updates with one press: the release's binary for this
  architecture is fetched, checked against the release's SHA256SUMS, swapped
  in under the running process and the service restarted — the same file the
  installer would fetch, in the same place, with the old one kept beside it as
  `tenkstack.prev`. Nothing phones home.
  A release can also move an engine to another image; the Engines page then
  offers the new one for each launcher the console wrote, and leaves a
  launcher edited by hand alone.
- **Connections** — one row per way in: the address, who may reach it, whether
  it is open, and a client configuration example. `/v1/chat/completions` speaks
  OpenAI and `/v1/messages` speaks Anthropic, both proxied to the same models,
  so Claude Code and Codex point here as readily as anything else.

## Architecture

```
Caddy ──┬── :8443 https  console (UI + API + /v1 proxy)
        ├── :8000 http   /v1 only, for clients that cannot trust a private CA
        └── :8444 https  ComfyUI, gated by forward_auth against the console
                │
        tenkstack :8070 ┬── llama-swap :8080 ──> llama-server per model
                        │                        native build, or the vendor's
                        │                        official image in a container
                        ├── ComfyUI :8188+, one instance per GPU
                        └── SearXNG :8090, what the agent's searches go through
```

Everything except Caddy binds to loopback, so the network cannot bypass
authentication. ComfyUI has no auth of its own; publishing it on `0.0.0.0`
would hand the GPU to anyone who can reach the host.

The backend is deliberately thin. llama-swap owns model lifecycle and ComfyUI
owns image generation; this process exists to merge their state with the GPU
telemetry neither can produce on Intel, to own the two jobs neither does at all
(downloads, accounts), and to serve the result over one SSE stream.

## Design notes worth knowing

**Model configuration is `llama-swap`'s `config.yaml`.** There is no management
API for adding models, but there is `-watch-config`, so the file *is* the
interface. It is written with `ruamel.yaml` in round-trip mode: the file carries
comments explaining the VRAM policy, and `safe_dump` would delete every one of
them on the first edit made through the UI. Rendered YAML is parsed back before
it replaces the real file — emptying a commented mapping makes ruamel print
orphaned comments above a bare `{}` at column zero, which is unparseable.

Parsing is not enough, though, and finding that out cost an afternoon: a file
that is valid YAML but the wrong shape makes llama-swap log one warning and
keep serving the config it read last, so every edit through the console appears
to work and none of them apply. Only llama-swap knows its own schema, so it is
asked — the write is bracketed by a journal cursor, and a config it will not
take is rolled back rather than left in place.

**Downloads are segmented.** A single TCP stream to Hugging Face's Xet CDN
measured ~8 MiB/s from Taiwan (60 ms RTT, heavy packet reordering); eight
streams to the *same* endpoint reached 41 MiB/s. The limit is the
bandwidth-delay product of one connection, not the server or the link.

**Speed is estimated from the header, not from the file size.** Hugging Face
serves ranged requests on GGUF files, and a GGUF opens with a complete
description of itself: the architecture metadata, then a directory naming every
tensor with its shape and quantisation type. Eight megabytes of a twenty
gigabyte file is enough to answer how fast it would run, because generation is
bandwidth-bound — bytes read per token over what the card delivers, plus a fixed
cost per block. Two details separate that from `size / bandwidth`, and both are
counted from the tensor names: a mixture-of-experts model reads a fraction of
itself (Qwen3-30B-A3B Q4_K_M is 17.3 GiB of file but 1.95 GiB of reading, since
8 of its 128 experts run per token), and a hybrid model caches on a minority of
its layers (Qwen3.8-27B declares 65 blocks; 17 of them hold a KV cache). The
constants are measured on this card — 568 GB/s from the Q6_K mat-vec kernel,
9.8 ms per token of launch overhead — which matters because the B70 will not
report its own memory bandwidth to anything: `xpu-smi` answers with a −1
sentinel and Level Zero answers 64-bit at 2800 MHz, off by an order of
magnitude. The estimate lands on the model measured here to within 0.3%; where a
file is known to break the assumption, the row says so instead of carrying a
correction factor.

**A card's job is derived, never stored.** Whether a card can run a model is
whether a configured launcher enumerates it — asked by running
`llama-server --list-devices`, not by consulting a table. Whether it draws
images is whether a container bound to it is up, and which card a container
holds is read from its device bindings rather than from its name, since
`--device /dev/dri/by-path/…` and a CUDA ordinal are facts while
`comfyui-nv0` is a convention somebody can rename. So there is no settings
file to fall out of step, and a host with one vendor, or three, needs nothing
edited.

**The VRAM policy asks which card, not device 0.** One 32 GB card shared
between a language model and ComfyUI needs an arbiter, and the console is the
only process that sees both. With a second card that arbitration has to know
where the model is going: it reads the card from the model entry's own
selector, measures free memory on that card, and matches ComfyUI instances to
cards through the container publishing the port each answers on — an exact
join, where comparing the device names two cards of the same model report
cannot be one.

**A second vendor is an image, not a second toolchain.** The native SYCL build
is worth keeping for the card whose owner is measuring it; for every other card
the goal is that it works without anyone installing a 10 GB toolchain, which is
what llama.cpp's per-backend images are for. The kernel driver has to be on the
host and cannot be anywhere else; everything above it belongs in the image.

**Capabilities are measured, not declared.** Vision support is read from
llama-server's `/props`, because a `--mmproj` flag pointing at a missing file
still appears on the command line. Stopped models fall back to what the config
declares, and the response says which of the two it is.

**A sandboxed frame has no origin.** The frames that run code carry
`sandbox="allow-scripts"` and deliberately not `allow-same-origin`, so their
origin is opaque and every request they make arrives with `Origin: null`. That
one fact decides two designs: the agent's web search runs on the server, because
almost nothing accepts that origin, and the CJK font matplotlib needs is served
from a route outside `/api` with a wildcard — the one thing here that reveals
nothing by being readable from anywhere. Messages from a frame are checked with
`event.source === frame.contentWindow`, never `event.origin`, which is `"null"`
for any sandboxed frame including a hostile one.

**The documents injected into those frames are checked before every build.**
They are template literals, so an escape written the ordinary way arrives
changed: `\b` became a backspace inside a regex, and a joined `\n` became a real
newline that left an unterminated string. Neither is visible in the source,
because the source is valid JavaScript either way — the mistake exists only in
the string the browser is handed, which is where `pnpm check:frames` looks.

**Numbers come from the source that owns them.** Throughput is llama-server's
own `timings`, not tokens divided by browser wall-clock, which would include
network and queue time. Time-to-first-token is measured in the browser, because
that is the thing the user actually waits for.

## Requirements

- A GPU and its vendor's tooling for telemetry: `xpu-smi` for Intel,
  `nvidia-smi` for NVIDIA, `rocm-smi` for AMD. Cards from more than one vendor
  in the same machine are the case this is written for, not an afterthought.
- Docker, and for NVIDIA the container toolkit. Both ComfyUI and — unless a
  card has a native build — llama-server run in containers, which is what keeps
  a second vendor from meaning a second userspace toolchain on the host. The
  console can install either from the official images; nothing has to be pulled
  by hand.
- A native `llama.cpp` build is optional and worth it for one card: the one
  whose owner is measuring it. On Intel that means the SYCL backend **and
  oneDNN** — `GGML_SYCL_DNN` defaults to ON but silently compiles itself out
  when `find_package(DNNL)` fails, and a build without it loses the XMX
  attention path: measured here at 254 t/s prefill against 291 at 32k context,
  generation unchanged. Two apt packages, not one: `intel-oneapi-dnnl` carries
  only the shared library, while the headers and `dnnl-config.cmake` are in
  `intel-oneapi-dnnl-devel`.
- [llama-swap](https://github.com/mostlygeek/llama-swap)
- [Caddy](https://caddyserver.com/) for TLS and the single entry point
- [SearXNG](https://github.com/searxng/searxng) on loopback, if the agent should
  be able to search (`install.sh --searxng` sets it up). Optional: the tool is
  offered to the model only when the instance answers, so an absent one removes
  the capability rather than breaking the chat.
- Nothing else: the console is one static binary with the frontend inside it.
  Go 1.27+ and Node 24+ only to build it yourself.

## Where things live

Every path the backend touches is an environment variable with a default, all
gathered in `internal/paths/paths.go`. The defaults describe one arrangement —
llama-swap, the models, llama.cpp, ComfyUI and Caddy side by side under one
root — and expand against whoever is running, so an unmodified checkout works
for any user with that layout.

The installer sets that root to `~/tenkstack` and writes it into the unit as
`CONSOLE_AI_DIR`, explicitly rather than by relying on the default, so an
installation that is already running cannot move because a default changed
later. A bare checkout with nothing set uses `~/ai`, the layout of the machine
this was first built on.

| Variable | Default | What it is |
|---|---|---|
| `CONSOLE_AI_DIR` | `~/ai` (installer: `~/tenkstack`) | Everything below is derived from this |
| `CONSOLE_STATE_DIR` | `$CONSOLE_AI_DIR/ai-console` | Session key and SQLite; the only thing the console writes |
| `CONSOLE_MODELS_DIR` | `$CONSOLE_AI_DIR/models` | The primary model location: GGUF and safetensors weights |
| `CONSOLE_LLAMA_SWAP_DIR` | `$CONSOLE_AI_DIR/llama-swap` | |
| `CONSOLE_LLAMA_SWAP_CONFIG` | `$CONSOLE_LLAMA_SWAP_DIR/config.yaml` | |
| `CONSOLE_LLAMA_SWAP_BIN` | `$CONSOLE_LLAMA_SWAP_DIR/llama-swap` | Read for its version |
| `CONSOLE_LLAMA_CPP_DIR` | `$CONSOLE_AI_DIR/llama.cpp` | Read for its commit |
| `CONSOLE_COMFYUI_DIR` | `$CONSOLE_AI_DIR/comfyui` | Holds `storage-models/`, `storage-user/` |
| `CONSOLE_CADDY_DIR` | `$CONSOLE_AI_DIR/caddy` | Channel files the console switches |
| `CONSOLE_CADDY_BIN` | `~/.local/bin/caddy` | Installed per-user, so not under the root above |
| `CONSOLE_ONEAPI_DIR` | `/opt/intel/oneapi` | Version panel only; absent is fine |

Only a layout that differs from that one needs any of them set. Nothing is
created — a missing directory is reported as missing, because turning "not set
up" into "set up and empty" hides the difference.

Models can live in up to five directories. The primary is
`CONSOLE_MODELS_DIR`; the others are added under Settings → 模型存放位置, and
each becomes a llama-swap macro, `models-dir-2` to `models-dir-5`, so an entry
names a file in one as `${models-dir-2}/owner/repo/file.gguf`. GGUF and
safetensors each have a default location new downloads land in, which lets
llama.cpp and vLLM weights live on different disks. Container launchers mount
every location, read at start from `model-locations` beside them.

Three more live with the code that reads them rather than in `paths`, because
none of them names a single location: `CONSOLE_FILE_ROOTS` declares what the file
browser may reach (`label=path`, separated by `;`, `ro:` in front of a path to
refuse writes) and replaces the defaults rather than adding to them, since
narrowing the set is the only reason to write it; `CONSOLE_FILE_DENY` adds paths
that are refused from every root; and `CONSOLE_SEARXNG_URL` says where searches
go, defaulting to `http://127.0.0.1:8090`.

Authentication switches itself on once the first account exists — requiring a
login before any account is created would lock the owner out with no way back
in.

## Not included

Operational configuration lives outside this repository, under the install
root: the `Caddyfile`, llama-swap's `config.yaml`, and the ComfyUI and SearXNG
launch scripts all carry host-specific addresses and flags. The installer
creates that tree with a skeleton config; the console then edits the config in
place. One such tree, the machine this was built on, is versioned separately
as [TenkStack-Host](https://github.com/NoobBandi/TenkStack-Host) — useful as a
worked example of what a tuned config looks like, not as something to copy.

The session signing key and the SQLite database holding password hashes and
API keys are excluded by `.gitignore` and must never be committed.

## License

[Apache License 2.0](LICENSE). Contributions are accepted under the same terms (Apache-2.0 §5), so no separate contributor agreement is needed — see [CONTRIBUTING.md](CONTRIBUTING.md) for how to run it from a checkout and what a pull request should carry.
