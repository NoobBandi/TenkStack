"""GPU telemetry, whichever vendors are installed.

The console asks the same four questions of every machine -- what cards are
here, what are they doing, what are their limits, and what else is worth
showing about them -- and one provider per vendor answers them. Everything
above this package works in watts and mebibytes and never learns which vendor
it is talking to.

EVERY VENDOR THAT FINDS HARDWARE PARTICIPATES

This used to stop at the first provider that found anything, on the assumption
that a machine has one kind of card. That assumption broke the day an RTX 3060
went in beside the Arc: Intel is asked first, answered, and the NVIDIA card
became invisible to a page whose entire job is showing what is installed.

So every provider is probed and every one that finds hardware contributes. The
cards are concatenated into one index space in a fixed order -- the order of
PROVIDERS, then each vendor's own -- which is what lets the rest of the console
go on addressing a card by a single integer. Indices are stable because that
order is stable and cards are not hot-plugged.

Intel is still first, and now that only decides numbering rather than who gets
heard. It matters for one thing: device 0 is the card llama-server runs on, and
the VRAM arbitration in main.py asks about device 0 by that name.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict, replace

from .base import GpuSample, Provider
from .amd import Amd
from .intel import Intel
from .nvidia import Nvidia

logger = logging.getLogger(__name__)

# Intel first, deliberately. It is the vendor this console exists for -- the
# others print a GPU panel in llama-swap already -- and it is the card the
# models here are built and flagged for, which is what makes it device 0.
PROVIDERS: list[Provider] = [Intel(), Nvidia(), Amd()]

# Which vendors have hardware, probed once and remembered. Separate from the
# routing table below because probing is the expensive half: it runs up to
# three CLIs, two of which are usually missing.
_live: list[Provider] | None = None

# Global device index -> (provider, that provider's own index). Rebuilt by
# discover(), which the history poller calls on its own schedule, so this stays
# current without sample() ever having to shell out to find out where to go.
_routes: list[tuple[Provider, int]] = []

_lock = asyncio.Lock()


async def providers() -> list[Provider]:
    """Vendors with hardware present, probed once and remembered.

    Re-probed while nothing has been found, so a driver that finishes loading
    after this process started is picked up without a restart. Once anything
    answers, the answer sticks: cards are not hot-plugged, and re-running three
    CLIs on every sample would undo the work done to keep the poller quiet.
    """
    global _live
    if _live:
        return _live

    async with _lock:
        if _live:
            return _live
        found: list[Provider] = []
        for candidate in PROVIDERS:
            try:
                devices = await candidate.discover()
            except Exception:
                logger.exception("%s provider failed while probing", candidate.key)
                continue
            if devices:
                found.append(candidate)
        if found:
            _live = found
            logger.info(
                "GPU providers: %s", ", ".join(p.label for p in found),
            )
        return found


def active_keys() -> list[str]:
    """Which vendors are in use, or empty while nothing has been probed."""
    return [p.key for p in _live] if _live else []


async def discover() -> list[dict]:
    """Every card on the machine, renumbered into one index space.

    Rebuilds the routing table as it goes. Each entry keeps the vendor that
    produced it, because on a mixed machine "device 1" says nothing useful
    without it.
    """
    global _routes

    routes: list[tuple[Provider, int]] = []
    out: list[dict] = []
    for impl in await providers():
        try:
            devices = await impl.discover()
        except Exception:
            logger.exception("%s provider failed while listing devices", impl.key)
            continue
        for entry in devices:
            local = entry.get("index", 0)
            routes.append((impl, local))
            out.append({**entry, "index": len(out), "vendor": impl.key})

    if routes:
        _routes = routes
    return out


async def _route(index: int) -> tuple[Provider, int] | None:
    """Which provider owns a global index, and what it calls that card."""
    if not _routes:
        await discover()
    if 0 <= index < len(_routes):
        return _routes[index]
    return None


async def sample(index: int = 0) -> GpuSample | None:
    route = await _route(index)
    if route is None:
        return None
    impl, local = route
    try:
        reading = await impl.sample(local)
    except Exception:
        logger.exception("%s provider failed while sampling device %s", impl.key, local)
        return None
    if reading is None:
        return None
    # Renumbered and labelled here rather than in each provider: a provider
    # knows its own cards and cannot know where they landed in the shared
    # numbering.
    return replace(reading, index=index, vendor=impl.key)


async def sample_dict(index: int = 0) -> dict | None:
    reading = await sample(index)
    if reading is None:
        return None
    return {**asdict(reading), "busy": reading.busy}


async def detail(index: int = 0) -> dict | None:
    route = await _route(index)
    if route is None:
        return None
    impl, local = route
    try:
        return await impl.detail(local)
    except Exception:
        logger.exception("%s provider failed while describing device %s", impl.key, local)
        return None


async def list_devices() -> list[dict]:
    """Every GPU, with its inventory and live counters attached."""
    devices = await discover()
    result = []
    for entry in devices:
        index = entry["index"]
        info, live = await asyncio.gather(detail(index), sample_dict(index))
        result.append({
            "index": index,
            "name": entry.get("name"),
            "drm_device": entry.get("drm_device"),
            "pci_bdf_address": entry.get("pci_bdf_address"),
            "state": entry.get("state"),
            "vendor": entry.get("vendor"),
            "groups": (info or {}).get("groups", []),
            "live": live,
        })
    return result


__all__ = [
    "GpuSample", "active_keys", "detail", "discover", "list_devices",
    "providers", "sample", "sample_dict",
]
