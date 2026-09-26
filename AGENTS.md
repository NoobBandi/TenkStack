# Adding a card

This console runs on whatever GPUs are in the machine, and "whatever" is meant
literally: Intel, NVIDIA and AMD are three records in
`server-go/internal/vendors/vendors.go` with a telemetry provider each under
`server-go/internal/gpu/`, and a fourth card is a fourth record plus a fourth
provider package. Nothing else in the codebase learns its name.

This document is how to write those — what to find out first, what to
implement, and how to know it works. It is written for a person or an agent who
has a card the author has never seen.

## The shape of the problem

The console asks two different kinds of question about a card, and they have
different answers:

**What is it doing?** Power, VRAM, clock, temperature. Vendor CLIs answer this
and they all answer it differently — `nvidia-smi` in one CSV, `xpu-smi` in JSON
across two sources, `rocm-smi` in its own. This is `gpu.Provider`, three
methods, and it has been vendor-neutral since before there was a second vendor.

**How does the rest of the platform use it?** Which environment variable pins
one of its devices, how a container is given one, how to read back which card
a container got, and which ComfyUI image runs on it. This is
`vendors.Vendor`, and it exists because those answers used to be scattered
through four files as `if vendor == "nvidia"`.

Read the `nvidia` record first — it is the vendor whose mechanisms are least
like the others, so it exercises the most of the record.

## Step 1 — find out what the machine can tell you

Before writing anything, answer these at a shell. Every one of them is a fact
the record needs, and guessing any of them costs an afternoon.

```bash
# Is there a CLI, and does it emit something parseable?
<vendor>-smi --help            # JSON output is worth looking for: --json, -j
                               # CSV with units stripped is next best

# What does the kernel call the device?
ls -l /dev/dri/by-path/        # render nodes, if the driver uses DRM at all
ls /dev/                       # Ascend is /dev/davinci*, others differ
lspci -nn | grep -i <vendor>

# Can llama.cpp see it, and what does it call the backend?
llama-server --list-devices    # the name before the index -- CUDA0, SYCL0 --
                               # is what Backends has to contain

# Does a container get the card, and how?
docker run --rm <flags you think work> <image> nvidia-smi   # or the equivalent
docker inspect <a working container> --format '{{json .HostConfig}}'
```

That last one matters more than it looks. `HostConfig` is where a container
records what it was given, and the `Claims` function reads exactly that. Look at
both `Devices` (a path passed through) and `DeviceRequests` (a toolkit was
asked for a device). If your vendor uses neither, you have found the reason
`Claims` is a function.

## Step 2 — the telemetry provider

A package under `internal/gpu/<name>/` implementing `gpu.Provider`:

```go
type Provider interface {
    Key() string
    Label() string
    Discover(ctx context.Context) ([]gpu.Device, error)   // index, name, pci_bdf_address, ...
    Sample(ctx context.Context, index int) (*api.GpuSample, error)
    Detail(ctx context.Context, index int) (*api.GpuDetail, error)
}
```

Rules that are not obvious and are load-bearing:

- **A missing tool returns an empty list, never an error.** `Discover` is how
  the console decides your vendor is not present, and it runs on every machine
  including the ones without your card. `gpu.Run` already turns a missing
  binary into exit 127 for this reason.
- **`PCIBDFAddress` is the join key** for everything outside telemetry — which
  container holds which card, which card a model runs on. Report it if the
  platform has one at all. Compare addresses with `containers.BusKey`, never as
  raw strings: the kernel writes four domain digits and lower case,
  `nvidia-smi` writes eight and upper.
- **A field you cannot measure is nil, not zero.** `gpu.ToFloat` already turns
  `N/A`, `[Not Supported]`, an empty string and an unsigned -1 into nil. A zero
  gets drawn on a chart.
- **`Detail` is vendor-shaped on purpose.** An Intel card has sub-slices and an
  NVIDIA one has SM counts; do not flatten yours into someone else's schema.

Then add it to the registry in `cmd/tenkstack/main.go` — Intel first, the rest
alphabetical, because the order decides the console's global device numbering
— and check it answers:

```bash
cd server-go && go run ./cmd/tenkstack -listen 127.0.0.1:8071 &
curl -s http://127.0.0.1:8071/api/gpu/devices | jq
```

## Step 3 — the vendor record

In `internal/vendors/vendors.go`, one more entry in `All()`:

```go
var musa = Vendor{
    Key: "musa", Label: "Moore Threads (MUSA)",     // Key must equal GpuSample.Vendor
    Backends:    []string{"MUSA"},                  // what --list-devices prints, upper case
    SelectorVar: "MUSA_VISIBLE_DEVICES", SelectorTemplate: "{}",
    Comfy: &Image{Image: "…"},                       // or nil
    DeviceFlags: func(card Card, cards []Card) []string { … },
    Claims:      func(host map[string]any, cards []Card) ([]string, bool) { … },
    Slot:        func(index int) string { return fmt.Sprintf("musa%d", index) },
}
```

The llama.cpp image that drives the card is not on this record. It is a
build under `builds:` in
`server-go/internal/providers/engines/llamacpp/engine.yaml`, keyed by the
vendor's `Key`, and any other inference engine that supports the card is a
build in its own `engine.yaml` there. The vendor says how a card is reached;
an engine says what runs on it. Adding a new engine rather than a card is
`server-go/internal/providers/engines/README.md`.

Notes on the parts that are easy to get subtly wrong:

**The selector takes the backend's own index, not the console's.** The console
numbers every card in the machine; `CUDA_VISIBLE_DEVICES=0` means the first
NVIDIA card. On a machine with an Intel card first, those are different
numbers. `nvidiaOrdinal` in `vendors.go` shows the conversion.

**`Verified: false` until you have run it on real hardware.** It is not
paperwork: the UI says 未驗證 next to the install button, which is worth saying
before a seven gigabyte download rather than after. Set it true in the pull
request that reports the measurement.

**`Comfy: nil` is a legitimate answer.** A vendor with no ComfyUI image simply
does not get an image switch, and the rest of the console handles that already.

**`Claims` is the inverse of `DeviceFlags`, not a copy of it.** Given a
container's `HostConfig`, return the PCI addresses it holds. Return
`nil, false` for a container that is not yours — every vendor is asked about
every container, and results are deduplicated, so a shared mechanism (the DRM
render node, which everything except NVIDIA uses; `ClaimsByRender`) is fine.

## Step 4 — prove it, then submit

`go test ./...` runs the vendor table against the goldens in
`internal/backends/testdata`; a new vendor with a llama image adds a line to
`runtimes.json` and a launcher script golden, written from the running code
once you have read it and agree with it.

Then the parts only real hardware can answer, and these are what a pull request
should report:

1. `/api/runtimes` lists your card with `llm` and `images` reflecting reality.
2. Installing llama.cpp for your vendor on the 推論引擎 page installs and
   enables a launcher, and `llama-server --list-devices` through it
   enumerates your card.
3. A model pinned to your card writes your selector into `config.yaml`, and
   the VRAM check before a load measures *your* card's free VRAM rather than
   device 0's.
4. A ComfyUI container created on your card is claimed back by `Claims` — check
   `/api/runtimes` shows it on your card's row, not on none and not on two,
   and `/api/containers/orphaned` does not list it.
5. Numbers: tokens/sec on a model you name, and VRAM at a stated context. State
   the quantisation. Without this nobody can tell a working port from one that
   silently fell back to the CPU.

## What is not a vendor

Three things look like they belong here and do not.

**Vulkan** is a backend, not a vendor: it runs on any card, which is why it is
the fallback in `backends` rather than a record. If your card works under
Vulkan and nothing else, you may not need a vendor record at all — say so in
the issue before writing one.

**A second llama.cpp build for a card that already has a vendor** is a launcher,
not a vendor. `config.yaml` macros name launchers, and the console discovers
them; see `Store.Launchers` in `internal/llamaswap`.

**MLX is a port, not a vendor.** See below.

## MLX, and why it is a different kind of work

Apple Silicon is the most requested platform that this document does not cover,
and the reason is worth stating precisely rather than as a shrug.

The inference half is closer than expected. `mlx_lm.server` speaks the same
OpenAI API this console already proxies — `/v1/chat/completions`,
`/v1/completions`, `/v1/models` — takes `--model`, `--host` and `--port`, loads
models on demand, and supports speculative decoding via `--draft-model`. Pointed
at by a llama-swap `cmd:`, it would slot in where llama-server does, and the
console's `/v1` proxy would need no changes at all.

What does not port is everything underneath:

| The console assumes | macOS |
|---|---|
| systemd user units | launchd |
| Docker with GPU passthrough | Docker exists; the GPU does not reach it |
| `xpu-smi` / `nvidia-smi` / `/sys/class/drm` | `powermetrics`, `ioreg`, and root for the useful parts |
| Models are GGUF | MLX has its own format; `mlx-community` on Hugging Face |
| **VRAM is a separate pool to arbitrate** | **Unified memory** |

The last row is the one that matters. This console's central mechanism — the
VRAM check before a load, the per-card role switches, evicting ComfyUI so a
model can load, `--n-cpu-moe` trading VRAM for system RAM — all rests on VRAM
being a scarce pool distinct from system memory. On Apple Silicon that
distinction does not exist, and the arbitration it drives is not wrong so much
as meaningless.

So MLX support is not a vendor record. It is: a second process supervisor, a
container story or an admission that there is none, a telemetry provider built
on entirely different tools, a catalog that knows a second weight format, and a
VRAM policy that has to be rethought rather than parameterised. That is a port,
and it should be opened as one — with the unified-memory question answered
first, because everything else follows from it.

## Where to look in the code

| Question | File |
|---|---|
| What a provider must answer | `server-go/internal/gpu/gpu.go` |
| A vendor with unusual mechanisms | `nvidia` in `server-go/internal/vendors/vendors.go`, `server-go/internal/gpu/nvidia/` |
| A vendor with shared mechanisms | `intel` and `ClaimsByRender` in the same file, `server-go/internal/gpu/intel/` |
| How vendors are found | `vendors.All()`; providers are listed in `cmd/tenkstack/main.go` |
| Who consumes the record | `internal/backends`, `internal/comfy`, `internal/containers` |
| Which engines run on a card | `server-go/internal/providers/engines/*/engine.yaml` |
| Which card a model runs on | `targetCard` and `makeRoom` in `internal/httpapi/comfy.go` |
