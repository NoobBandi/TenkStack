# Adding a card

This console runs on whatever GPUs are in the machine, and "whatever" is meant
literally: Intel, NVIDIA and AMD are three records in
`server-go/internal/vendors/vendors.go` with a telemetry provider each under
`server-go/internal/gpu/`, and a fourth card is a fourth record. Nothing else
in the codebase learns its name.

> The walkthrough below was written against the Python tree, which the Go
> port mirrors one to one: `vendors/nvidia.py` is `nvidia` in `vendors.go`,
> `gpu/nvidia.py` is `internal/gpu/nvidia/`. The questions, the two records
> and the proof required are the same; only the file names differ.

This document is how to write that file — what to find out first, what to
implement, and how to know it works. It is written for a person or an agent who
has a card the author has never seen.

## The shape of the problem

The console asks two different kinds of question about a card, and they have
different answers:

**What is it doing?** Power, VRAM, clock, temperature. Vendor CLIs answer this
and they all answer it differently — `nvidia-smi` in one CSV, `xpu-smi` in JSON
across two sources, `rocm-smi` in its own. This is `gpu.base.Provider`, three
async methods, and it has been vendor-neutral since before there was a second
vendor.

**How does the rest of the platform use it?** Which llama.cpp image drives it,
which environment variable pins one of its devices, how a container is given
one, and how to read back which card a container got. This is
`vendors.Vendor`, and it exists because those four answers used to be scattered
through four files as `if vendor == "nvidia"`.

Both live in one module. `vendors/nvidia.py` is the one to read first — it is
the vendor whose mechanisms are least like the others, so it exercises the most
of the record.

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
                               # is what `backends` has to contain

# Does a container get the card, and how?
docker run --rm <flags you think work> <image> nvidia-smi   # or the equivalent
docker inspect <a working container> --format '{{json .HostConfig}}'
```

That last one matters more than it looks. `HostConfig` is where a container
records what it was given, and the `claims` function reads exactly that. Look at
both `Devices` (a path passed through) and `DeviceRequests` (a toolkit was
asked for a device). If your vendor uses neither, you have found the reason
`claims` is a function.

## Step 2 — the telemetry provider

Three methods, in `gpu/base.py`:

```python
async def discover(self) -> list[dict]     # [{index, name, pci_bdf_address, ...}]
async def sample(self, index) -> GpuSample | None
async def detail(self, index) -> dict | None
```

Rules that are not obvious and are load-bearing:

- **A missing tool returns an empty list, never an exception.** `discover()` is
  how the console decides your vendor is not present, and it runs on every
  machine including the ones without your card. `gpu.base.run()` already turns a
  missing binary into `(127, "")` for this reason.
- **`pci_bdf_address` is the join key** for everything outside telemetry —
  which container holds which card, which card a model runs on. Report it if
  the platform has one at all. Compare addresses with `containers.bus_key`,
  never as raw strings: the kernel writes four domain digits and lower case,
  `nvidia-smi` writes eight and upper.
- **A field you cannot measure is `None`, not zero.** `gpu.base.to_float()`
  already turns `N/A`, `[Not Supported]`, an empty string and an unsigned -1
  into `None`. A zero gets drawn on a chart.
- **`detail()` is vendor-shaped on purpose.** An Intel card has sub-slices and
  an NVIDIA one has SM counts; do not flatten yours into someone else's schema.

Sanity check before going further:

```python
python -c "
import asyncio
from app.vendors.<name> import VENDOR
print(asyncio.run(VENDOR.provider.discover()))
print(asyncio.run(VENDOR.provider.sample(0)))
"
```

## Step 3 — the vendor record

```python
VENDOR = Vendor(
    key="musa",                       # must equal GpuSample.vendor
    label="Moore Threads (MUSA)",
    provider=Musa(),
    backends=("MUSA",),               # what --list-devices prints, upper case
    selector=("MUSA_VISIBLE_DEVICES", "{}"),
    llama=Image(image="…", requires="…", verified=False),
    comfy=Image(image="…", verified=False) or None,
    device_flags=lambda card, cards: [...],
    claims=lambda host, cards: ([...], True),
    slot=lambda index: f"musa{index}",
)
```

Notes on the parts that are easy to get subtly wrong:

**`selector` takes the backend's own index, not the console's.** The console
numbers every card in the machine; `CUDA_VISIBLE_DEVICES=0` means the first
NVIDIA card. On a machine with an Intel card first, those are different
numbers. `vendors/nvidia.py` shows the conversion.

**`verified=False` until you have run it on real hardware.** It is not
paperwork: the UI says 未驗證 next to the install button, which is worth saying
before a seven gigabyte download rather than after. Set it true in the pull
request that reports the measurement.

**`comfy=None` is a legitimate answer.** A vendor with no ComfyUI image simply
does not get an image switch, and the rest of the console handles that already.

**`claims` is the inverse of `device_flags`, not a copy of it.** Given a
container's `HostConfig`, return the PCI addresses it holds. Return
`([], False)` for a container that is not yours — every vendor is asked about
every container, and results are deduplicated, so a shared mechanism (the DRM
render node, which everything except NVIDIA uses) is fine.

## Step 4 — prove it, then submit

The console has no vendor list to update: dropping the file in is the
registration. Verify that end to end rather than trusting it.

```python
python -c "
from app import vendors, backends, comfy
print([v.key for v in vendors.all_vendors()])          # yours is there
print(vendors.backend_selectors())                      # your backend maps
print({k: v['image'] for k, v in backends._runtimes().items()})
print(sorted(comfy._images()))                          # absent if comfy=None
"
```

Then the parts only real hardware can answer, and these are what a pull request
should report:

1. `/api/runtimes` lists your card with `llm` and `images` reflecting reality.
2. Turning the model switch on installs and enables a launcher, and
   `llama-server --list-devices` through it enumerates your card.
3. A model pinned to your card writes your selector into `config.yaml`, and
   `make_room_for` measures *your* card's free VRAM rather than device 0's.
4. A ComfyUI container created on your card is claimed back by `claims` — check
   `/api/runtime` shows it holding the right card, not none and not two.
5. Numbers: tokens/sec on a model you name, and VRAM at a stated context. State
   the quantisation. Without this nobody can tell a working port from one that
   silently fell back to the CPU.

## What is not a vendor

Three things look like they belong here and do not.

**Vulkan** is a backend, not a vendor: it runs on any card, which is why it is
the fallback in `backends.FALLBACK` rather than a record. If your card works
under Vulkan and nothing else, you may not need a vendor file at all — say so
in the issue before writing one.

**A second llama.cpp build for a card that already has a vendor** is a launcher,
not a vendor. `config.yaml` macros name launchers, and the console discovers
them; see `backends._launchers`.

**MLX is a port, not a vendor.** See below.

## MLX, and why it is a different kind of work

Apple Silicon is the most requested platform that this document does not cover,
and the reason is worth stating precisely rather than as a shrug.

The inference half is closer than expected. `mlx_lm.server` speaks the same
OpenAI API this console already proxies — `/v1/chat/completions`,
`/v1/completions`, `/v1/models` — takes `--model`, `--host` and `--port`, loads
models on demand, and supports speculative decoding via `--draft-model`. Pointed
at by a llama-swap `cmd:`, it would slot in where llama-server does, and the
console's `/v1` proxy would need no changes at all. The ecosystem is alive:
`ml-explore/mlx` and `mlx-lm` were both pushed to this week.

What does not port is everything underneath:

| The console assumes | macOS |
|---|---|
| systemd user units | launchd |
| Docker with GPU passthrough | Docker exists; the GPU does not reach it |
| `xpu-smi` / `nvidia-smi` / `/sys/class/drm` | `powermetrics`, `ioreg`, and root for the useful parts |
| Models are GGUF | MLX has its own format; `mlx-community` on Hugging Face |
| **VRAM is a separate pool to arbitrate** | **Unified memory** |

The last row is the one that matters. This console's central mechanism —
`make_room_for`, the per-card role switches, evicting ComfyUI so a model can
load, `--n-cpu-moe` trading VRAM for system RAM — all rests on VRAM being a
scarce pool distinct from system memory. On Apple Silicon that distinction does
not exist, and the arbitration it drives is not wrong so much as meaningless.

So MLX support is not a `vendors/mlx.py`. It is: a second process supervisor, a
container story or an admission that there is none, a telemetry provider built
on entirely different tools, a catalog that knows a second weight format, and a
VRAM policy that has to be rethought rather than parameterised. That is a port,
and it should be opened as one — with the unified-memory question answered
first, because everything else follows from it.

## Where to look in the code

| Question | File |
|---|---|
| What a provider must answer | `server/app/gpu/base.py` |
| A vendor with unusual mechanisms | `server/app/vendors/nvidia.py` |
| A vendor with shared mechanisms | `server/app/vendors/intel.py`, `_shared.py` |
| How vendors are found | `server/app/vendors/__init__.py` |
| Who consumes the record | `gpu/__init__.py`, `backends.py`, `comfy.py`, `containers.py` |
| Which card a model runs on | `main.py` — `_target_card`, `make_room_for` |
