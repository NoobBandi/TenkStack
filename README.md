<p align="center">
  <img src="https://cdn.quantdense.com/tenkstack/tenkstack-banner.png"
       alt="TenkStack" width="820">
</p>

# TenkStack

A self-hosted control panel for a machine with one or more GPUs that runs
language models and generates images. Language models are served by
[llama.cpp](https://github.com/ggml-org/llama.cpp),
[vLLM](https://github.com/vllm-project/vllm) or
[SGLang](https://github.com/sgl-project/sglang), all started and stopped
through [llama-swap](https://github.com/mostlygeek/llama-swap); images by
[ComfyUI](https://github.com/comfyanonymous/ComfyUI). The console adds what
none of them has: a dashboard that reads every card, a chat with an agent that
can run code and search, a model catalogue that downloads from Hugging Face,
accounts and API keys, and an OpenAI- and Anthropic-compatible endpoint that
Claude Code, Codex and anything else can point at.

Each card can run models, draw images, both, or nothing, and every surface
reports per card rather than per machine. Intel, NVIDIA and AMD are
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
installed later from the console's 推論引擎 and ComfyUI pages. On Intel,
ComfyUI needs `xpu-smi` present for the console to see the cards.

Other flags:

| | |
|---|---|
| `--lang en\|zh-TW` | The installer's language; otherwise asked first, defaulting to the locale. |
| `--dir PATH` | Install directory (default `~/tenkstack`). |
| `--source` | Build from a git checkout instead of downloading a release binary; installs Go and Node. |
| `--code PATH` | Where that checkout goes (default `~/dev/tenkstack`). |
| `--no-searxng` | Pre-answer "no" to SearXNG. |
| `--no-tui` | Plain questions instead of the setup screens. |
| `--yes`, `-y` | Take every default and ask nothing. |
| `--dry-run` | Print what would be done and do none of it. |
| `--help`, `-h` | The list, in the chosen language. |

The environment variables it reads are `TENKSTACK_REPO` (the git URL `--source`
clones), `TENKSTACK_REF` (the branch or tag, default `main`),
`TENKSTACK_RELEASE` (where release binaries are downloaded from) and the ports
`CONSOLE_PORT`, `CONSOLE_TLS_PORT`, `CONSOLE_API_PORT`,
`CONSOLE_LLAMA_SWAP_PORT` and `CONSOLE_SEARXNG_PORT`.

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

The sidebar names are the interface's own, in Traditional Chinese.

- **Dashboard** (總覽) — one block per GPU: power, VRAM, clock and tokens/sec, live,
  with needle-less gauges for host CPU, memory and disk beside them and a chart
  that switches cards from a dropdown. GPU telemetry comes from `xpu-smi` and
  `nvidia-smi` together, because llama-swap probes only for the latter and
  reports nothing on Intel.
- **Chat** (對話) — streaming, with server-measured throughput, context-window usage,
  image attachments and a composer that shades ``` code fences as you type.
  Sampling settings are seeded from the model's own llama-swap entry, so the
  config and the panel cannot disagree, and a control the model's engine does
  not take is hidden rather than sent.
- **Agent** — the model runs Python to answer, up to eight steps by default,
  choosing what to do next from what came back, and searches the web the same
  way. The Python runs on the server in a gVisor container when the machine
  has one, otherwise in the browser (see the design notes below). One trace
  above the reply carries the working in the order it happened: each thought,
  each program, its output, its figures, and the pages a search actually read —
  a citation nobody can follow is decoration.
- **Previews** — HTML, SVG, React, Markdown and Python open in a panel beside
  the reply, HTML and Markdown as the document they describe rather than as
  source. React is transpiled in the frame instead of being posted to a compiler
  service; Python is CPython on WebAssembly. Nothing in a frame can reach the
  host, which is what the button is allowed to promise.
- **Models** (模型) — add, edit and remove models for any installed engine: a
  GGUF file for llama.cpp, or a safetensors folder for vLLM or SGLang with its
  context, card count, memory share and optional on-the-fly quantisation;
  optionally delete their weights from disk; spot orphaned files and
  interrupted downloads. One vision projector can serve several llama.cpp
  models, and each entry says which it is using. On a machine where more than
  one card can run a model, an entry also says which card — and the field
  appears only there, because a single usable card is not a choice.
- **Quantise** (量化, a button on 模型) — turn a bf16 safetensors folder into
  a smaller one beside it, FP8, Int8 or AutoRound Int4, for vLLM. The tool is
  Intel's auto-round in a container derived from the installed vLLM image,
  built on first use; one job runs at a time, on the card picked. GGUF stays
  with llama.cpp's own tools and the quants publishers already ship.
- **Catalog** (模型目錄) — search Hugging Face and download either a GGUF file
  or a whole safetensors folder, segmented and resumable, into per-repo folders
  so two publishers' identically named quants stay distinct; a file the Hub
  lists a SHA256 for is checked against it before it is kept. Split GGUF
  uploads are listed as one model rather than as the fragments they arrive in,
  since no fragment is usable alone. Any GGUF quant can be asked what it would
  generate at *on this card* before the download starts, worked out from the
  file's own header. An access token for gated models is set under 設定.
- **Engines** (推論引擎) — the inference engines, one card each: what it is good
  at, which model files it runs, and whether it runs on this machine's cards.
  Installing one pulls the vendor's official image (llama.cpp, vLLM, SGLang)
  and writes a launcher that llama-swap starts it through; a build not yet run
  on a vendor's card is marked 未驗證. Each launcher shows which tag of its
  image it runs, offers any other tag the registry has, and notices when a
  moving tag such as `latest` has moved. Engines are records, not code:
  [internal/providers/engines](internal/providers/engines/README.md).
- **Cards** (顯示卡) — one tile per GPU: what it is doing, what is on it
  (models and containers, by name) and how it is connected, with the vendor
  tool's full report folded underneath. Which job a card has is not a stored
  preference: it runs models when an installed engine can use it, and draws
  images when a ComfyUI container bound to it is up, so the page cannot come to
  disagree with the machine.
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
  `# managed by TenkStack` line to take the hook over. A card with no instance
  is listed with a 建立實例 button, which pulls the vendor's image and gives
  the instance its own port, storage and Caddy site block, with a bar.
- **Files** (檔案) — laid out the way a file manager is: locations down the left,
  the path as crumbs, the folder in the middle, and what the selection is on
  the right; opening a text file adds a tab with Monaco underneath. The whole
  disk rather than one application's folders: declared
  roots, a deny list the console cannot be talked out of, and previews for
  images, text, and weights — a GGUF or safetensors header is read in place, so
  a 20 GB file answers what it is without being moved. Uploads are chunked and
  resumable, streamed to disk rather than buffered. Administrator only, and
  only from a signed-in browser: an API key never opens it.
- **Logs** (日誌) — one stream for every part of the platform: the user units from
  the systemd journal, the ComfyUI containers from `docker logs`. The window
  on screen is read from those stores, so an hour is an hour of history
  whatever the console has been doing, and a week answers in about a second
  because journalctl is asked only for what the units' own processes wrote.
  Sources sit down the left with whether each is being read and how many
  lines it put in the window, which is the answer to "is this being recorded
  at all". The console's own polling of llama-swap and Caddy is flagged and
  hidden by default.
- **Benchmark** (跑分) — a fixed suite run against one model: time to first
  token, prompt and generation speed, and how much slower each gets with a
  longer context or several users at once. Runs are kept, and up to three can
  be set side by side, which is how a change of KV cache type, speculative
  decoding or memory share is judged. Administrator only, because a run
  unloads other models and pauses `/v1` while it measures.
- **Users** (使用者) — accounts, roles and API keys for the API below. An
  administrator changes the machine for everyone; a member chats, loads and
  unloads models, and manages their own password and keys.
- **Settings** (設定) — what a reasonable owner would want different and
  nothing else can derive: model locations, the agent's step limit and Python
  sandbox, the Hugging Face token, how language models and ComfyUI share a
  card's memory, how much history is kept, and the llama-swap config file
  itself. Administrator only.
- **About** (關於) — what this is and where it comes from, and whether there is a
  newer one: each installation asks GitHub for the latest release itself, a
  few times a day, and marks the version in the sidebar when there is. The
  administrator updates with one press: the release's binary for this
  architecture is fetched, checked against the release's SHA256SUMS, swapped
  in under the running process and the service restarted — the same file the
  installer would fetch, in the same place, with the old one kept beside it as
  `tenkstack.prev`. Nothing phones home.
  A release can also move an engine to another image; the 推論引擎 page then
  offers the new one for each launcher the console wrote, and leaves a
  launcher edited by hand alone.
- **Connections** (連線) — one row per way in: the address, who may reach it, whether
  it is open, and a client configuration example. `/v1/chat/completions` speaks
  OpenAI and `/v1/messages` speaks Anthropic, both proxied to the same models,
  so Claude Code and Codex point here as readily as anything else.

## Architecture

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
boundary between users of the same machine; [SECURITY.md](SECURITY.md) says
what that means.)

The backend is deliberately thin. llama-swap owns model lifecycle and ComfyUI
owns image generation; this process exists to merge their state with the GPU
telemetry neither can produce on Intel, to own the jobs none of them does at
all (downloads, accounts, installing engines), and to serve the result over
one SSE stream.

## Design notes worth knowing

**Model configuration is `llama-swap`'s `config.yaml`.** There is no management
API for adding models, but there is `-watch-config`, so the file *is* the
interface — for every engine, since a vLLM or SGLang entry is a llama-swap
model like any other, its command a launcher macro followed by one flag per
line. The file is read into a `gopkg.in/yaml.v3` node tree and written back
from it (`internal/llamaswap/config.go`), not decoded into structs: the file
carries comments explaining the VRAM policy, and a struct round-trip would
delete every one of them on the first edit made through the UI. yaml.v3 keeps
comments, order and block scalars but drops a blank line that touches no
comment, so blank lines are turned into marker comments before parsing and
back afterwards. The new file replaces the old one by rename, so llama-swap
never reads half of it.

Valid YAML is not enough, though, and finding that out cost an afternoon: a
file that is valid YAML but the wrong shape makes llama-swap log one warning
and keep serving the config it read last, so every edit through the console
appears to work and none of them apply. Only llama-swap knows its own schema,
so it is asked: the write is bracketed by a cursor into llama-swap's user
journal (the console reads the unit the installer writes and the name older
installs used), and a config it reports it will not take is rolled back rather
than left in place. When no verdict arrives within ten seconds — the journal
cannot be read, say — the new file stays.

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

**A card's job is derived, never stored.** Whether a card can run a llama.cpp
model is whether a configured launcher enumerates it — asked by running
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
declares, and the response says which of the two it is. A vLLM or SGLang model
has no `/props`; what it takes is read from the folder's own `config.json`.

**A sandboxed frame has no origin.** The frames that run code carry
`sandbox="allow-scripts"` and deliberately not `allow-same-origin`, so their
origin is opaque and every request they make arrives with `Origin: null`. That
one fact decides two designs: the agent's web search runs on the server, because
almost nothing accepts that origin, and the CJK font matplotlib needs is served
from a route outside `/api` with a wildcard — the one thing here that reveals
nothing by being readable from anywhere. Messages from a frame are checked with
`event.source === frame.contentWindow`, never `event.origin`, which is `"null"`
for any sandboxed frame including a hostile one.

**The agent's Python runs on the server when it can, under gVisor.** Each
conversation gets a container started with `--runtime=runsc`, no network, no
mounts, a read-only root, two size-capped tmpfs and a memory, CPU and process
limit; the code travels on stdin to a kernel inside it, never into docker's
arguments. gVisor is the boundary: its sentry answers the system calls itself,
so the host kernel -- which also holds the GPUs and every model -- is not what
generated code talks to. The kernel keeps one namespace for the conversation,
so variables and files survive between calls; a call past the time limit gets
SIGINT and keeps them, and only one that ignores it costs the container.
Without runsc nothing runs on the server at all and the chat falls back to
Pyodide in the browser: the plain Docker runtime is not offered as a weaker
alternative. The image is built here from `internal/sandbox/image`, tagged by a
hash of those files, from 設定 → 對話 → Python 沙箱.

**The documents injected into those frames are checked before every build.**
They are template literals, so an escape written the ordinary way arrives
changed: `\b` became a backspace inside a regex, and a joined `\n` became a real
newline that left an unterminated string. Neither is visible in the source,
because the source is valid JavaScript either way — the mistake exists only in
the string the browser is handed, which is where `pnpm check:frames` looks.

**Numbers come from the source that owns them.** Throughput is llama-server's
own `timings`, not tokens divided by browser wall-clock, which would include
network and queue time. vLLM and SGLang report nothing per request, so for
them the reply is measured on its way through the console's proxy, from the
token counts the engine is asked to put on every chunk — counting chunks
instead would read a third of the real rate under speculative decoding.
Time-to-first-token is measured in the browser, because that is the thing the
user actually waits for.

## Requirements

- A GPU and its vendor's tooling for telemetry: `xpu-smi` for Intel,
  `nvidia-smi` for NVIDIA, and for AMD `amd-smi`, with `rocm-smi` as the
  fallback for older ROCm installs. Cards from more than one vendor in the same
  machine are the case this is written for, not an afterthought. Intel and
  NVIDIA are run here daily; **AMD is unverified** — its telemetry and
  container recipes were written from the tools' documentation without an AMD
  card to run them on, and a report from someone who has one is welcome.
- Docker, and for NVIDIA the container toolkit. ComfyUI, vLLM, SGLang and —
  unless a card has a native build — llama-server run in containers, which is
  what keeps a second vendor from meaning a second userspace toolchain on the
  host. The console installs each from the official images; nothing has to be
  pulled by hand.
- [gVisor](https://gvisor.dev/) (`runsc` registered with Docker) if the agent's
  Python should run on the server. Optional: without it the chat runs Python
  in the browser instead.
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
| `CONSOLE_STATE_DIR` | `$CONSOLE_AI_DIR/ai-console` | The console's own state: `session.key`, the database (`postgres/`, `backups/`), chat images (`blobs/`), `huggingface-token`, the build contexts of the sandbox and quantisation images (`sandbox/`, `quant/`), and a few JSON files of history and preferences |
| `CONSOLE_DATABASE_URL` | unset | Another PostgreSQL to use instead of the console's own, which is then not set up |
| `CONSOLE_MODELS_DIR` | `$CONSOLE_AI_DIR/models` | The primary model location: GGUF and safetensors weights |
| `CONSOLE_LLAMA_SWAP_DIR` | `$CONSOLE_AI_DIR/llama-swap` | |
| `CONSOLE_LLAMA_SWAP_CONFIG` | `$CONSOLE_LLAMA_SWAP_DIR/config.yaml` | |
| `CONSOLE_LLAMA_SWAP_BIN` | `$CONSOLE_LLAMA_SWAP_DIR/llama-swap` | Read for its version |
| `CONSOLE_LLAMA_SWAP_ACTIVITY` | `$CONSOLE_LLAMA_SWAP_DIR/activity.sqlite` | llama-swap's own per-request history, opened read-only |
| `CONSOLE_LLAMA_CPP_DIR` | `$CONSOLE_AI_DIR/llama.cpp` | Read for its commit |
| `CONSOLE_COMFYUI_DIR` | `$CONSOLE_AI_DIR/comfyui` | Holds `storage-models/`, `storage-user/` |
| `CONSOLE_CADDY_DIR` | `$CONSOLE_AI_DIR/caddy` | Channel files the console switches |
| `CONSOLE_CADDY_BIN` | `~/.local/bin/caddy` | Installed per-user, so not under the root above |
| `CONSOLE_ONEAPI_DIR` | `/opt/intel/oneapi` | Version panel only; absent is fine |

Only a layout that differs from that one needs any of them set. Nothing in
that table is created — a missing directory is reported as missing, because
turning "not set up" into "set up and empty" hides the difference.

The state directory is not the only thing the console writes, though. It
edits llama-swap's `config.yaml` and writes the engine launchers beside it,
switches Caddy's channel files, downloads models into the model locations,
creates ComfyUI's storage, writes its own PostgreSQL unit under
`~/.config/systemd/user/`, and, when the administrator updates from 關於,
replaces its own binary.

Ports, from `internal/ports`:

| Variable | Default | What it is |
|---|---|---|
| `CONSOLE_PORT` | `8070` | The console behind Caddy; `install.sh` writes it into the unit's `-listen` and the Caddyfile |
| `CONSOLE_TLS_PORT` | `8443` | Caddy's entry for the interface and the encrypted `/v1` |
| `CONSOLE_API_PORT` | `8000` | Caddy's plain-HTTP `/v1` |
| `CONSOLE_LLAMA_SWAP_PORT` | `8080` | Where llama-swap answers; `/v1` is proxied here |
| `CONSOLE_COMFYUI_PORT` | `8188` | The first loopback port a ComfyUI instance publishes on |
| `CONSOLE_COMFYUI_COUNT` | `4` | How many instances a machine may have, one port each from the first |
| `CONSOLE_COMFYUI_PUBLIC_PORT` | `8444` | The first port Caddy serves ComfyUI on, one per instance |

The unit the installer writes carries the ports it chose for the console,
llama-swap, Caddy's two entries and SearXNG; the ComfyUI ones keep their
defaults unless given to `tenkstack-console.service` in a drop-in.

The process itself:

| Variable | Default | What it is |
|---|---|---|
| `CONSOLE_LISTEN` | `127.0.0.1:8071` | Where the binary serves; the `-listen` flag overrides it, and the installed unit passes `-listen 127.0.0.1:$CONSOLE_PORT` |
| `CONSOLE_WEB_DIST` | unset | Serve the frontend from this directory instead of the copy embedded in the binary (same as `-web`) |
| `TENKSTACK_REPO` | `NoobBandi/TenkStack` | The GitHub repository the update check asks for releases |
| `TENKSTACK_RELEASE_API` | `https://api.github.com` | The API it asks, for a mirror or a test server |

`install.sh` reads a `TENKSTACK_REPO` of its own, and there it is a git URL
for `--source`, not `owner/repo`: set it for one or the other, not both.

Models can live in up to five directories. The primary is
`CONSOLE_MODELS_DIR`; the others are added under 設定 → 模型存放 → 存放位置, and
each becomes a llama-swap macro, `models-dir-2` to `models-dir-5`, so an entry
names a file in one as `${models-dir-2}/owner/repo/file.gguf`. GGUF and
safetensors each have a default location new downloads land in, which lets
llama.cpp and vLLM or SGLang weights live on different disks. Container launchers mount
every location, read at start from `model-locations` beside them.

Three more live with the code that reads them rather than in `paths`, because
none of them names a single location: `CONSOLE_FILE_ROOTS` declares what the file
browser may reach (`label=path`, separated by `;`, `ro:` in front of a path to
refuse writes) and replaces the default roots rather than adding to them, since
narrowing the set is the only reason to write it — the model locations and
ComfyUI's directories are still offered; `CONSOLE_FILE_DENY` adds paths that
are refused from every root, separated by `:` like `PATH`, `~/` allowed, on top
of a built-in list (the state directory, `~/.ssh`, `~/.gnupg`, `~/.aws`,
`~/.docker`, `~/.kube` and a few more); and `CONSOLE_SEARXNG_URL` says where
searches go, defaulting to `http://127.0.0.1:8090`.

Before the first account exists there is nobody to sign in as, so the console
admits only a browser that opened its setup link: the address the installer
prints at the end, with `?setup=<token>` on it. The token is in `setup-token`
in the state directory and in the console's log; it stops working once the
first account is created, and from then on signing in is required.

## Not included

Operational configuration lives outside this repository, under the install
root: the `Caddyfile`, llama-swap's `config.yaml` and the engine launchers
beside it all carry host-specific addresses and flags. The installer creates
that tree with a skeleton config; the console then edits the config in
place. One such tree, the machine this was built on, is versioned separately
as [TenkStack-Host](https://github.com/NoobBandi/TenkStack-Host) — useful as a
worked example of what a tuned config looks like, not as something to copy.

The session signing key and the database holding password hashes and API keys
are excluded by `.gitignore` and must never be committed.

### The database

Accounts, API keys, conversations and settings are in PostgreSQL, which the
console runs for itself: on its first start it writes
`tenkstack-postgres.service`, a user unit running the official `postgres`
image as the console's own user with its files in `$CONSOLE_STATE_DIR/postgres`.
The container has no network and the server no TCP listener; the only way in
is a unix socket in a directory only that user can enter, so there is no
password to keep. An install from before this imports its SQLite file on that
first start and keeps it beside the database as `console.sqlite.migrated-*`.

```bash
tenkstack backup              # → $CONSOLE_STATE_DIR/backups/console-<time>.dump
docker exec -i tenkstack-postgres pg_restore -U tenkstack -d tenkstack --clean --if-exists < FILE
```

## License

[Apache License 2.0](LICENSE). Contributions are accepted under the same terms (Apache-2.0 §5), so no separate contributor agreement is needed — see [CONTRIBUTING.md](CONTRIBUTING.md) for how to run it from a checkout and what a pull request should carry.
