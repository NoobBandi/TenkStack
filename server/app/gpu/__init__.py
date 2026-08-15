"""GPU telemetry, whichever vendor is installed.

The console asks the same four questions of every machine -- what cards are
here, what are they doing, what are their limits, and what else is worth
showing about them -- and one provider per vendor answers them. Everything
above this package works in watts and mebibytes and never learns which vendor
it is talking to.

Selection is by probe, not by configuration: each provider is asked to list its
devices, and the first that finds any wins. A machine with no supported tool
reports no GPUs and the rest of the console carries on, which is the same thing
that happens when xpu-smi is missing today.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict

from .base import GpuSample, Provider
from .amd import Amd
from .intel import Intel
from .nvidia import Nvidia

logger = logging.getLogger(__name__)

# Intel first, deliberately. It is the vendor this console exists for -- the
# others print a GPU panel in llama-swap already -- and on a mixed machine it is
# the one whose numbers would otherwise go unreported.
PROVIDERS: list[Provider] = [Intel(), Nvidia(), Amd()]

_active: Provider | None = None
_lock = asyncio.Lock()


async def provider() -> Provider | None:
    """The vendor in use, probed once and remembered.

    Re-probed while nothing has been found, so a driver that finishes loading
    after this process started is picked up without a restart. Once a vendor
    answers, the answer sticks: cards are not hot-plugged, and re-running three
    CLIs on every sample would undo the work done to keep the poller quiet.
    """
    global _active
    if _active is not None:
        return _active

    async with _lock:
        if _active is not None:
            return _active
        for candidate in PROVIDERS:
            try:
                devices = await candidate.discover()
            except Exception:
                logger.exception("%s provider failed while probing", candidate.key)
                continue
            if devices:
                _active = candidate
                logger.info("GPU provider: %s (%d device(s))", candidate.label, len(devices))
                return _active
    return None


def active_key() -> str | None:
    """Which vendor was selected, or None while nothing has been probed."""
    return _active.key if _active else None


async def discover() -> list[dict]:
    impl = await provider()
    return await impl.discover() if impl else []


async def sample(index: int = 0) -> GpuSample | None:
    impl = await provider()
    if impl is None:
        return None
    try:
        return await impl.sample(index)
    except Exception:
        logger.exception("%s provider failed while sampling device %s", impl.key, index)
        return None


async def sample_dict(index: int = 0) -> dict | None:
    reading = await sample(index)
    if reading is None:
        return None
    return {**asdict(reading), "busy": reading.busy}


async def detail(index: int = 0) -> dict | None:
    impl = await provider()
    if impl is None:
        return None
    try:
        return await impl.detail(index)
    except Exception:
        logger.exception("%s provider failed while describing device %s", impl.key, index)
        return None


async def list_devices() -> list[dict]:
    """Every GPU, with its inventory and live counters attached."""
    devices = await discover()
    result = []
    for entry in devices:
        index = entry.get("index", 0)
        info, live = await asyncio.gather(detail(index), sample_dict(index))
        result.append({
            "index": index,
            "name": entry.get("name"),
            "drm_device": entry.get("drm_device"),
            "pci_bdf_address": entry.get("pci_bdf_address"),
            "state": entry.get("state"),
            "vendor": active_key(),
            "groups": (info or {}).get("groups", []),
            "live": live,
        })
    return result


__all__ = [
    "GpuSample", "active_key", "detail", "discover", "list_devices",
    "provider", "sample", "sample_dict",
]
