"""Host CPU, memory and disk.

Read straight from /proc and statvfs rather than pulling in psutil: these three
files are a stable kernel interface, and the dependency would earn its place
only if far more were needed than this.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path

logger = logging.getLogger(__name__)

MODELS_DIR = Path("/home/tenk/ai/models")

# CPU utilisation is a rate, so it only exists between two readings of the
# cumulative counters. The previous sample lives here.
_previous: tuple[float, int, int] | None = None


def _cpu_counters() -> tuple[int, int] | None:
    """(idle, total) jiffies from the aggregate line of /proc/stat."""
    try:
        with open("/proc/stat") as handle:
            fields = handle.readline().split()
    except OSError:
        return None
    if not fields or fields[0] != "cpu":
        return None

    values = [int(v) for v in fields[1:11] if v.isdigit()]
    if len(values) < 5:
        return None
    # user nice system idle iowait irq softirq steal ...
    idle = values[3] + values[4]
    return idle, sum(values)


def _cpu_percent() -> float | None:
    global _previous
    counters = _cpu_counters()
    if counters is None:
        return None
    idle, total = counters
    now = time.time()

    if _previous is None:
        _previous = (now, idle, total)
        # The first call has nothing to compare against; a fabricated 0% would
        # read as an idle machine rather than as "not yet known".
        return None

    _, prev_idle, prev_total = _previous
    _previous = (now, idle, total)

    delta_total = total - prev_total
    if delta_total <= 0:
        return None
    return round((1 - (idle - prev_idle) / delta_total) * 100, 1)


def _meminfo() -> dict[str, int]:
    values: dict[str, int] = {}
    try:
        with open("/proc/meminfo") as handle:
            for line in handle:
                key, _, rest = line.partition(":")
                parts = rest.split()
                if parts and parts[0].isdigit():
                    values[key] = int(parts[0]) * 1024  # kB -> bytes
    except OSError:
        pass
    return values


def _cpu_model() -> str | None:
    try:
        with open("/proc/cpuinfo") as handle:
            for line in handle:
                if line.startswith("model name"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return None


def _disk(path: Path) -> dict | None:
    try:
        stat = os.statvfs(path)
    except OSError:
        return None
    total = stat.f_blocks * stat.f_frsize
    # Three quantities, not two. f_bavail is what an ordinary process may use;
    # f_bfree additionally counts the root-reserved blocks (5% on a default
    # ext4). Reporting only "used" and "available" makes the arithmetic appear
    # broken -- total minus used does not equal available -- so the reserve is
    # reported explicitly and the three sum to the total.
    free = stat.f_bavail * stat.f_frsize
    used = total - (stat.f_bfree * stat.f_frsize)
    reserved = (stat.f_bfree - stat.f_bavail) * stat.f_frsize
    return {
        "path": str(path),
        "total_bytes": total,
        "used_bytes": used,
        "free_bytes": free,
        "reserved_bytes": reserved,
        # Matches `df`: the denominator is what is actually obtainable, so the
        # figure lines up with the tool people check it against.
        "percent": round(used / (used + free) * 100, 1) if (used + free) else 0.0,
    }


def sample() -> dict:
    mem = _meminfo()
    total = mem.get("MemTotal", 0)
    available = mem.get("MemAvailable", 0)
    swap_total = mem.get("SwapTotal", 0)
    swap_free = mem.get("SwapFree", 0)

    try:
        load1, load5, load15 = os.getloadavg()
    except OSError:
        load1 = load5 = load15 = 0.0

    uptime = None
    try:
        with open("/proc/uptime") as handle:
            uptime = float(handle.readline().split()[0])
    except (OSError, ValueError, IndexError):
        pass

    disks = [d for d in (_disk(Path("/")), ) if d]
    # Only list the models directory separately when it is a different
    # filesystem; otherwise it is the same bar twice.
    models_disk = _disk(MODELS_DIR)
    if models_disk and disks and models_disk["total_bytes"] != disks[0]["total_bytes"]:
        models_disk["path"] = str(MODELS_DIR)
        disks.append(models_disk)

    return {
        "cpu": {
            "percent": _cpu_percent(),
            "cores": os.cpu_count(),
            "model": _cpu_model(),
            "load": [round(load1, 2), round(load5, 2), round(load15, 2)],
        },
        "memory": {
            "total_bytes": total,
            "available_bytes": available,
            "used_bytes": total - available,
            "percent": round((total - available) / total * 100, 1) if total else 0.0,
        },
        "swap": {
            "total_bytes": swap_total,
            "used_bytes": swap_total - swap_free,
            "percent": round((swap_total - swap_free) / swap_total * 100, 1) if swap_total else 0.0,
        },
        "disks": disks,
        "uptime_seconds": uptime,
    }
