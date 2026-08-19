"""Which cards this machine can actually run a model on.

Not which cards exist -- that is the GPU page's question, and the two answers
differ. A card runs a language model only if there is a llama-server build that
can see it: the SYCL build on this host enumerates the Arc and nothing else,
because the RTX card is not a Level Zero device. Asking it is the only honest
way to know, so this module asks:

    llama-server --list-devices
    Available devices:
      SYCL0: Intel(R) Arc(TM) Pro B70 Graphics (32656 MiB, 32092 MiB free)

The launchers come from llama-swap's own config rather than from a constant
here, because that file is already the single source of truth for how a model
is started. Whatever a model entry's `cmd` begins with is the thing that would
run, so that is the thing that gets asked.

This exists to answer one question for the UI: is there a choice to make? On a
machine with one usable card there is not, and asking the user which card to
run on would be a form field with a single option. The moment a second runtime
is configured -- a CUDA llama.cpp for the NVIDIA card -- the question starts
having two answers and the field appears on its own, with nobody having
remembered to turn it on.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shlex
from dataclasses import dataclass
from pathlib import Path

from . import config, paths

logger = logging.getLogger(__name__)

# `  SYCL0: Intel(R) Arc(TM) Pro B70 Graphics (32656 MiB, 32092 MiB free)`
_DEVICE = re.compile(r"^\s*([A-Za-z]+)(\d+):\s*(.*?)\s*\((\d+)\s*MiB")

# How a backend is told to use one card. The variable is what a model entry
# carries as its `env`; the value is the backend's own numbering, which is not
# the console's -- a CUDA ordinal counts NVIDIA cards alone.
_SELECTOR = {
    "SYCL": ("ONEAPI_DEVICE_SELECTOR", "level_zero:{}"),
    "CUDA": ("CUDA_VISIBLE_DEVICES", "{}"),
    "ROCM": ("HIP_VISIBLE_DEVICES", "{}"),
    "VULKAN": ("GGML_VK_VISIBLE_DEVICES", "{}"),
}

# The SYCL wrapper pins one card by default, which is right for running and
# wrong for enumerating. It defaults the variable rather than assigning it, so
# this overrides it for the probe alone.
_PROBE_ENV = {"ONEAPI_DEVICE_SELECTOR": "level_zero:*"}

# Sourcing oneAPI's setvars.sh is most of this, and it is not fast.
_TIMEOUT = 90

_cache: list[dict] | None = None


def _launchers() -> list[str]:
    """The commands that start a model, one per distinct launcher.

    Read from `cmd` rather than configured here: a second backend arrives as a
    new model entry pointing at a different launcher, and nothing else should
    have to be told about it.
    """
    try:
        data = config._load()
    except Exception:
        logger.exception("could not read the config while looking for launchers")
        return []

    macros = data.get("macros") or {}
    found: list[str] = []

    # A macro naming an executable is a launcher this machine has, whether or
    # not a model entry uses it yet. That matters for exactly the case this
    # whole per-card arrangement is for: a runtime is installed before the
    # first model is pointed at it, and until then the console would report one
    # usable card and hide the choice that has just become real.
    for value in macros.values():
        path = Path(str(value))
        if path.is_file() and os.access(path, os.X_OK):
            found.append(str(path))

    for spec in (data.get("models") or {}).values():
        text = str((spec or {}).get("cmd") or "").strip()
        if not text:
            continue
        first = text.splitlines()[0].strip()
        for key, value in macros.items():
            first = first.replace("${%s}" % key, str(value))
        if "${" in first or not first:
            continue
        launcher = shlex.split(first)[0] if first else ""
        if launcher and launcher not in found:
            found.append(launcher)
    return found


async def _ask(launcher: str) -> list[dict]:
    environ = {**os.environ, **_PROBE_ENV}
    try:
        proc = await asyncio.create_subprocess_exec(
            launcher, "--list-devices",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=environ,
        )
    except OSError as exc:
        logger.warning("could not run %s: %s", launcher, exc)
        return []

    try:
        out, _ = await asyncio.wait_for(proc.communicate(), _TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        logger.warning("%s --list-devices timed out", launcher)
        return []

    devices = []
    for line in out.decode("utf-8", "replace").splitlines():
        match = _DEVICE.match(line)
        if not match:
            continue
        backend, index, name, total = match.groups()
        variable, template = _SELECTOR.get(backend.upper(), ("", ""))
        devices.append({
            "backend": backend,
            "index": int(index),
            "name": name,
            "total_mib": int(total),
            "launcher": launcher,
            # What a model entry carries to pin itself to this card. Empty for
            # a backend this module has no selector for, which the UI treats as
            # "cannot be chosen" rather than guessing a variable name.
            "env": {variable: template.format(index)} if variable else {},
        })
    return devices


def selector_vars() -> set[str]:
    """The environment variables this module writes into a model entry.

    Handed to the config writer so it can clear a previous choice without
    touching a variable somebody added by hand.
    """
    return {variable for variable, _ in _SELECTOR.values()}


async def usable(refresh: bool = False) -> list[dict]:
    """Every card a configured llama-server can see, across all launchers.

    Cached: the answer changes when the build changes or a card is added, not
    between requests, and each probe costs a oneAPI environment setup.
    """
    global _cache
    if _cache is not None and not refresh:
        return _cache

    found: list[dict] = []
    for launcher in _launchers():
        for device in await _ask(launcher):
            # Two launchers of the same backend would enumerate the same cards.
            if not any(d["backend"] == device["backend"] and d["index"] == device["index"]
                       for d in found):
                found.append(device)
    _cache = found
    logger.info("llama-server sees %d device(s): %s",
                len(found), ", ".join(f"{d['backend']}{d['index']} {d['name']}" for d in found))
    return found


def match(devices: list[dict], cards: list[dict]) -> list[dict]:
    """Attach each usable device to the console's own card entry, if it can.

    By name, which is all `--list-devices` gives -- there is no PCI address in
    that output. Two identical cards in one machine are therefore
    indistinguishable here, and the second one is left unmatched rather than
    attached to the first: a wrong card is worse than no card, because the VRAM
    policy would then measure the wrong one.
    """
    taken: set[str] = set()
    out = []
    for device in devices:
        card = None
        for entry in cards:
            address = entry.get("pci_bdf_address")
            if not address or address in taken:
                continue
            if (entry.get("name") or "").strip() == device["name"].strip():
                card = entry
                taken.add(address)
                break
        out.append({**device, "pci_bdf_address": (card or {}).get("pci_bdf_address")})
    return out


# --------------------------------------------------------------------------
# Adding a runtime for a card that has none
#
# The console is the only thing here that knows both which cards are in the
# machine and which of them a llama-server can drive, so it is where the gap
# gets closed. What it writes is a launcher script and a macro naming it --
# never a free-form command -- which keeps this on the same side of the line as
# the container page: a fixed template with no field the user fills in.
#
# The images are the official ones. Building llama.cpp from source is the right
# answer for exactly one card, the one whose owner is measuring it; for every
# other card the goal is that it works without anyone installing a 10 GB
# toolchain, and that is what these are for.
# --------------------------------------------------------------------------

RUNTIMES: dict[str, dict] = {
    "nvidia": {
        "label": "NVIDIA (CUDA)",
        "image": "ghcr.io/ggml-org/llama.cpp:server-cuda",
        # --gpus needs nvidia-container-toolkit on the host; the kernel driver
        # alone is not enough.
        "flags": ["--gpus", "all"],
        "requires": "nvidia-container-toolkit",
        "verified": True,
    },
    "intel": {
        "label": "Intel (SYCL)",
        "image": "ghcr.io/ggml-org/llama.cpp:server-intel",
        # By path, not by number: render node numbering is probe order, so a
        # second card can silently move renderD128 to another device.
        "flags": ["--device", "/dev/dri"],
        "requires": None,
        "verified": False,
    },
    "amd": {
        "label": "AMD (ROCm)",
        "image": "ghcr.io/ggml-org/llama.cpp:server-rocm",
        "flags": ["--device", "/dev/kfd", "--device", "/dev/dri",
                  "--group-add", "video", "--security-opt", "seccomp=unconfined"],
        "requires": None,
        # No AMD card has ever been in this machine. Written from the
        # documented recipe and never run, which is worth saying out loud
        # rather than discovering at load time.
        "verified": False,
    },
}

# The fallback, and deliberately not a default. It is one tenth the size and
# runs on any vendor, but it needs a Vulkan ICD on the host -- and a
# compute-only NVIDIA install, which is the ordinary shape on a server, has
# CUDA and no Vulkan at all. Measured on this machine: the Intel card
# enumerates through it, the NVIDIA card reports no devices.
FALLBACK = {
    "label": "Vulkan（通用備援）",
    "image": "ghcr.io/ggml-org/llama.cpp:server-vulkan",
    "flags": ["--device", "/dev/dri", "--gpus", "all",
              "-e", "NVIDIA_DRIVER_CAPABILITIES=graphics,compute,utility"],
    "requires": "vulkan ICD",
    "verified": False,
}


def wrapper_text(vendor: str, models_dir: str) -> str:
    """The launcher script for one vendor, ready to write.

    Two details make the container invisible to the rest of the config, and
    both are load-bearing: the models directory is mounted at the path it has
    on the host, so `--model ${models-dir}/...` needs no rewriting and an entry
    can move between this launcher and a native one unchanged; and the
    container runs with --network host, so `--port ${PORT}` lands where
    llama-swap expects it.
    """
    spec = RUNTIMES.get(vendor) or FALLBACK
    flags = " ".join(shlex.quote(f) for f in spec["flags"])
    selector = _SELECTOR_FOR_VENDOR.get(vendor)
    forward = ""
    if selector:
        forward = f'''
# Forwarded only when it has a value. An empty {selector} does not mean "no
# preference" -- it means *no devices*, and the container then reports that it
# cannot find a card on a machine where the card is fine.
SELECT=()
if [[ -n "${{{selector}:-}}" ]]; then
  SELECT=(-e "{selector}=${selector}")
fi
'''
    select_arg = '  "${SELECT[@]}" \\\n' if selector else ""
    return f'''#!/usr/bin/env bash
# llama-server for the {spec["label"]} card, in a container, generated by the
# console. Edit freely -- nothing regenerates this file once it exists.
#
# A container rather than a build on this host: a second vendor means a second
# userspace runtime beside the first, and installing them side by side is where
# that arrangement starts to rot. The kernel driver has to be on the host and
# cannot be anywhere else; everything above it belongs to the image.
set -euo pipefail

IMAGE="${{LLAMA_IMAGE:-{spec["image"]}}}"
MODELS_DIR="{models_dir}"

# Named so `cmdStop` can reach it. llama-swap signals this script, and a
# `docker run` that is killed leaves its container running -- the signal has to
# arrive at the container instead, which is what `docker stop` does.
NAME="${{LLAMA_NAME:-llama-{vendor}}}"
{forward}
exec docker run --rm --init \\
  --name "$NAME" \\
  {flags} \\
  --network host \\
{select_arg}  -v "$MODELS_DIR:$MODELS_DIR:ro" \\
  "$IMAGE" "$@"
'''


_SELECTOR_FOR_VENDOR = {
    "nvidia": "CUDA_VISIBLE_DEVICES",
    "intel": "ONEAPI_DEVICE_SELECTOR",
    "amd": "HIP_VISIBLE_DEVICES",
}


@dataclass
class Install:
    """One runtime being added, as the page needs to show it."""
    vendor: str
    image: str
    state: str = "pulling"      # pulling | writing | done | error
    layers_done: int = 0
    layers_total: int = 0
    message: str = ""

    def as_dict(self) -> dict:
        return {
            "vendor": self.vendor, "image": self.image, "state": self.state,
            "layers_done": self.layers_done, "layers_total": self.layers_total,
            "message": self.message,
        }


_installs: dict[str, Install] = {}


async def coverage(cards: list[dict]) -> list[dict]:
    """One row per card in the machine: can anything here run a model on it?

    The question the console is uniquely able to answer, because it is the only
    thing that sees both lists. A card with no runtime is not broken and not an
    error -- it is a card doing something else, or one waiting for an image --
    so this reports rather than warns.
    """
    from . import containers

    devices = match(await usable(), cards)
    driven = {containers.bus_key(d["pci_bdf_address"])
              for d in devices if d.get("pci_bdf_address")}

    rows = []
    for card in cards:
        address = card.get("pci_bdf_address")
        vendor = card.get("vendor") or ""
        spec = RUNTIMES.get(vendor)
        rows.append({
            "pci_bdf_address": address,
            "name": card.get("name"),
            "vendor": vendor,
            "covered": bool(address and containers.bus_key(address) in driven),
            # What would be installed for it. An unverified recipe is worth
            # saying before the download, not after.
            "runtime": {**spec, "vendor": vendor} if spec else None,
            "install": _installs[vendor].as_dict() if vendor in _installs else None,
        })
    return rows


async def _pull(record: "Install") -> bool:
    """docker pull, with the only progress its non-interactive output carries.

    There are no byte counts without a terminal, so layers are what can be
    counted honestly -- better than a spinner for a 7 GiB image, and better
    than a percentage invented from nothing.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker", "pull", record.image,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except OSError as exc:
        record.state, record.message = "error", str(exc)
        return False

    assert proc.stdout is not None
    while True:
        raw = await proc.stdout.readline()
        if not raw:
            break
        line = raw.decode("utf-8", "replace").strip()
        if line.endswith("Pulling fs layer"):
            record.layers_total += 1
        elif line.endswith("Pull complete") or line.endswith("Already exists"):
            record.layers_done += 1
        elif line:
            record.message = line[:200]

    if await proc.wait() != 0:
        record.state = "error"
        return False
    return True


async def install(vendor: str) -> dict:
    """Add a runtime for one vendor: pull the image, write the launcher, name it.

    Every step is fixed and none of it is free-form. The image comes from the
    table above, the script from `wrapper_text`, and the macro is the one name
    that makes the launcher discoverable -- there is nowhere for a caller to
    put a flag of its own, which is what keeps this on the same side of the
    line as the container page's restart.
    """
    from . import config

    spec = RUNTIMES.get(vendor)
    if spec is None:
        raise ValueError(f"沒有 {vendor} 的執行環境範本")

    running = _installs.get(vendor)
    if running and running.state in {"pulling", "writing"}:
        return running.as_dict()

    path = config.CONFIG_PATH.parent / f"llama-server-{vendor}.sh"
    if path.exists():
        raise ValueError(f"{path.name} 已經存在，沒有覆寫它")

    record = Install(vendor=vendor, image=spec["image"])
    _installs[vendor] = record

    async def run() -> None:
        if not await _pull(record):
            return
        record.state = "writing"
        try:
            path.write_text(wrapper_text(vendor, str(paths.MODELS_DIR)), encoding="utf-8")
            path.chmod(0o755)
            await config.add_macro(f"llama-{vendor}", str(path))
        except Exception as exc:
            record.state, record.message = "error", str(exc)
            logger.exception("could not register the %s runtime", vendor)
            return
        # The probe caches, and a new launcher is exactly what invalidates it.
        await usable(refresh=True)
        record.state, record.message = "done", str(path)

    asyncio.create_task(run())
    return record.as_dict()
