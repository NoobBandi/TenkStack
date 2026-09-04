"""Server-side GPU history.

The dashboard used to start its chart empty and fill it as samples arrived, so
opening the page told you nothing about the last hour -- exactly the window you
care about after a job finishes. Sampling belongs here instead: one poller for
the whole process, its buffer served to every client that connects.

Everything is keyed by device index. A second card must not need a second
poller, a second buffer type, or a second code path -- with one card installed
these structures simply hold one entry, which is also the only configuration
that can be tested on this machine.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque

from . import gpu

logger = logging.getLogger(__name__)

SAMPLE_INTERVAL = 2.0
# Two hours at one sample every two seconds. Enough to cover a long generation
# or a model load and still be a few hundred KB of JSON at worst.
CAPACITY = int(2 * 3600 / SAMPLE_INTERVAL)


def set_hours(hours: int) -> None:
    """How long a card's samples are kept, applied to the buffers already open."""
    global CAPACITY
    wanted = int(hours * 3600 / SAMPLE_INTERVAL)
    if wanted == CAPACITY:
        return
    CAPACITY = wanted
    for index, samples in list(_history.items()):
        _history[index] = deque(samples, maxlen=CAPACITY)
    logger.info("GPU history resized to %d hours", hours)
# How often the device list is re-read. Cards do not appear at runtime, but the
# poller starts before xpu-smi is necessarily answering, so this is what lets a
# late-arriving device be picked up without a restart.
DISCOVER_EVERY = 60.0

_history: dict[int, deque[dict]] = {}
_latest: dict[int, dict] = {}
_task: asyncio.Task | None = None


def indices() -> list[int]:
    """Device indices seen so far, in order."""
    return sorted(_latest)


def latest_all() -> list[dict]:
    """The newest sample for every device, lowest index first."""
    return [_latest[i] for i in sorted(_latest)]


def history(index: int, seconds: int | None = None,
            max_points: int = 600) -> list[dict]:
    """Recent samples for one device, thinned to at most `max_points`.

    A chart cannot draw 3600 points usefully and the browser should not have to
    parse them, so long windows are decimated rather than truncated -- keeping
    the whole span visible at lower resolution beats showing only the tail.
    """
    points = list(_history.get(index, ()))
    if seconds is not None:
        cutoff = time.time() - seconds
        points = [p for p in points if p["t"] >= cutoff]

    if len(points) > max_points:
        step = len(points) / max_points
        points = [points[int(i * step)] for i in range(max_points)]
    return points


def history_all(seconds: int | None = None,
                max_points: int = 600) -> dict[int, list[dict]]:
    return {i: history(i, seconds, max_points) for i in sorted(_history)}


async def _poll() -> None:
    known: list[int] = []
    discovered_at = 0.0

    while True:
        try:
            now = time.time()
            if not known or now - discovered_at >= DISCOVER_EVERY:
                devices = await gpu.discover()
                # `index`, not `device_id`. That key is xpu-smi's own and never
                # reaches here -- both providers translate it away -- so this
                # matched nothing and the fallback below was the only path
                # taken. Invisible with one card, and with two it would have
                # left the second one without any history at all.
                found = sorted(
                    d["index"] for d in devices if d.get("index") is not None
                )
                # Fall back to device 0 rather than sampling nothing: discovery
                # can fail while stats still answer, and an empty dashboard is a
                # worse failure than one device reported without its list entry.
                known = found or [0]
                discovered_at = now

            # Sequential, not gathered: each call shells out to xpu-smi, and
            # running them at once makes the readings contend for the same
            # driver interface rather than finish sooner.
            for index in known:
                sample = await gpu.sample_dict(index)
                if sample is None:
                    continue
                _latest[index] = sample
                _history.setdefault(index, deque(maxlen=CAPACITY)).append({
                    "t": time.time(),
                    "power": sample.get("power_w"),
                    "vram": sample.get("memory_used_mib"),
                    "freq": sample.get("frequency_mhz"),
                    "temp": sample.get("temperature_c"),
                    "util": sample.get("memory_util_percent"),
                })
        except Exception:
            # A failed reading must not end the poller; the next one may work.
            logger.exception("GPU sampling failed")
        await asyncio.sleep(SAMPLE_INTERVAL)


def start() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_poll())
        logger.info("GPU history poller started (%.0fs interval, %d capacity)",
                    SAMPLE_INTERVAL, CAPACITY)


async def stop() -> None:
    if _task and not _task.done():
        _task.cancel()
        await asyncio.gather(_task, return_exceptions=True)
