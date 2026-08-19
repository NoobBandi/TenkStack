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
from pathlib import Path

from . import config

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
