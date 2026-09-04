"""Per-container CPU and memory, sampled from cgroup.

Added for one question that nothing else on this console can answer: why a
container died. Docker reports exit code 137 for a kill, and under cgroup v2 the
`OOMKilled` flag is routinely false even when memory was the cause -- so a
container the operator stopped and a container the kernel shot look identical
afterwards. The five minutes of memory before it went is the difference.

Read from `/sys/fs/cgroup`, not from `docker stats`. The numbers are the same --
that is where docker reads them -- but `docker stats --no-stream` samples twice
to compute a CPU percentage and takes about a second, while the files answer in
microseconds:

    docker stats --no-stream   1.088 s
    cgroup, two containers     0.000265 s

At two seconds per sample the second figure is free and the first is not.

CPU is kept as a number but not charted anywhere: on this machine the work is on
the GPU and the containers around it idle at a tenth of a percent. Memory is the
series with a story in it.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from pathlib import Path

from . import containers

logger = logging.getLogger(__name__)

SAMPLE_INTERVAL = 2.0
# Two hours, matching the GPU history: long enough to cover a model load or a
# long generation, and at two containers this is a few hundred kilobytes.
CAPACITY = int(2 * 3600 / SAMPLE_INTERVAL)

# How often the container list is re-read. Containers do start and stop while
# the console runs -- unlike cards -- but not every two seconds.
DISCOVER_EVERY = 10.0

CGROUP = Path("/sys/fs/cgroup")

_history: dict[str, deque[dict]] = {}
_latest: dict[str, dict] = {}
_previous: dict[str, tuple[float, int]] = {}     # name -> (wall time, cpu usec)
_task: asyncio.Task | None = None


def _scope(container_id: str) -> Path | None:
    """Where this container's controllers live.

    Two layouts are tried because the placement is the init system's choice, not
    docker's: systemd puts each container in its own scope under system.slice,
    while the cgroupfs driver nests them under /sys/fs/cgroup/docker.
    """
    for path in (CGROUP / "system.slice" / f"docker-{container_id}.scope",
                 CGROUP / "docker" / container_id):
        if path.is_dir():
            return path
    return None


def _read(scope: Path) -> dict | None:
    try:
        memory = int((scope / "memory.current").read_text())
        limit_raw = (scope / "memory.max").read_text().strip()
        cpu = dict(
            line.split(maxsplit=1)
            for line in (scope / "cpu.stat").read_text().splitlines()
            if " " in line
        )
        usage_usec = int(cpu["usage_usec"])
    except (OSError, ValueError, KeyError):
        # A container that stopped between listing and reading takes its cgroup
        # with it. Nothing to report and nothing wrong.
        return None
    return {
        "memory": memory,
        # "max" means no limit was set, which is the common case and is not the
        # same as a limit of zero.
        "memory_limit": None if limit_raw == "max" else int(limit_raw),
        "usage_usec": usage_usec,
    }


def latest_all() -> list[dict]:
    """The newest sample for every container being watched."""
    return [_latest[name] for name in sorted(_latest)]


def history(name: str, seconds: int | None = None,
            max_points: int = 240) -> list[dict]:
    """Recent samples for one container, thinned rather than truncated.

    Decimated the same way the GPU history is: a sparkline 120 pixels wide
    cannot use 3600 points, and dropping the older half would hide exactly the
    part somebody opened the chart to see.
    """
    points = list(_history.get(name, ()))
    if seconds is not None:
        cutoff = time.time() - seconds
        points = [p for p in points if p["t"] >= cutoff]
    if len(points) > max_points:
        step = len(points) / max_points
        points = [points[int(i * step)] for i in range(max_points)]
    return points


def history_all(seconds: int | None = None,
                max_points: int = 240) -> dict[str, list[dict]]:
    return {name: history(name, seconds, max_points) for name in sorted(_history)}


async def _sample_once(known: dict[str, str]) -> None:
    now = time.time()
    for name, container_id in known.items():
        scope = _scope(container_id)
        if scope is None:
            continue
        reading = _read(scope)
        if reading is None:
            continue

        # CPU as a percentage of one core, from the difference between two
        # readings -- the file holds a total since start, which on its own says
        # nothing about now.
        previous = _previous.get(name)
        _previous[name] = (now, reading["usage_usec"])
        percent = None
        if previous:
            elapsed = now - previous[0]
            if elapsed > 0:
                percent = round(
                    (reading["usage_usec"] - previous[1]) / 1e4 / elapsed, 2)

        sample = {
            "name": name,
            "t": now,
            "memory": reading["memory"],
            "memory_limit": reading["memory_limit"],
            "cpu_percent": percent,
        }
        _latest[name] = sample
        _history.setdefault(name, deque(maxlen=CAPACITY)).append(
            {"t": now, "memory": reading["memory"], "cpu": percent})


async def _poll() -> None:
    known: dict[str, str] = {}
    discovered_at = 0.0

    while True:
        try:
            now = time.time()
            if not known or now - discovered_at >= DISCOVER_EVERY:
                known = await containers.running_ids()
                discovered_at = now
                # A container that has gone keeps its history -- that is the
                # whole point -- but must not keep a stale "latest", which would
                # read as a live figure on a dead row.
                for name in list(_latest):
                    if name not in known:
                        _latest.pop(name, None)
                        _previous.pop(name, None)
            await _sample_once(known)
        except Exception:
            # One bad reading must not end the poller.
            logger.exception("container sampling failed")
        await asyncio.sleep(SAMPLE_INTERVAL)


def start() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_poll())
        logger.info("container history poller started (%.0fs interval)",
                    SAMPLE_INTERVAL)


async def stop() -> None:
    if _task and not _task.done():
        _task.cancel()
        await asyncio.gather(_task, return_exceptions=True)
