"""Intel Arc GPU telemetry via xpu-smi.

llama-swap probes for nvidia-smi and rocm-smi only, so on this machine its GPU
panel is empty and every GPU number in the console has to come from here.

xpu-smi is shelled out to rather than linked: Intel ships no Python binding, and
the JSON output is a stable enough contract for a single-host console.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
from dataclasses import asdict, dataclass

logger = logging.getLogger(__name__)

XPU_SMI = shutil.which("xpu-smi") or "/usr/bin/xpu-smi"

# Idle on the B70. Kept here because it is the reference that makes a "is it
# actually on the GPU?" judgement possible at all -- a load that never rises
# above this ran on the CPU, whatever the logs claim.
IDLE_POWER_W = 46.0
IDLE_FREQ_MHZ = 400.0


@dataclass(frozen=True)
class GpuSample:
    index: int
    name: str
    power_w: float | None
    memory_used_mib: float | None
    memory_total_mib: float | None
    memory_util_percent: float | None
    frequency_mhz: float | None
    temperature_c: float | None

    @property
    def busy(self) -> bool:
        """Whether the card looks like it is actually working.

        Power alone is not enough: memory can be held by an idle resident model
        while nothing computes. Frequency is what separates "loaded" from "busy".
        """
        if self.power_w is None or self.frequency_mhz is None:
            return False
        return self.power_w > IDLE_POWER_W * 1.2 and self.frequency_mhz > IDLE_FREQ_MHZ * 1.5


async def _run(*args: str, timeout: float = 5.0) -> dict | list | None:
    try:
        proc = await asyncio.create_subprocess_exec(
            XPU_SMI, *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        logger.warning("xpu-smi not found at %s; GPU telemetry disabled", XPU_SMI)
        return None

    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        logger.warning("xpu-smi %s timed out after %.0fs", " ".join(args), timeout)
        return None

    if proc.returncode != 0:
        logger.warning("xpu-smi %s failed: %s", " ".join(args), stderr.decode(errors="replace").strip())
        return None

    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        logger.warning("xpu-smi %s returned non-JSON output", " ".join(args))
        return None


def _dig(obj: dict | None, *path: str) -> float | None:
    """Walk a path of dict keys, returning None if any step is missing.

    The stats payload nests per-tile: power.gpu_power_w.tile_0.current. Single-
    tile cards still use tile_0, so the path is uniform, but a field that the
    hardware does not report is simply absent rather than null -- hence the
    tolerant walk instead of chained .get() calls.
    """
    cur: object = obj
    for key in path:
        if not isinstance(cur, dict) or key not in cur:
            return None
        cur = cur[key]
    return cur if isinstance(cur, (int, float)) else None


async def discover() -> list[dict]:
    """Enumerate discrete Intel GPUs. Cheap enough to call once at startup."""
    data = await _run("discovery", "-j")
    if not data:
        return []
    devices = data.get("device_list", []) if isinstance(data, dict) else []
    return [d for d in devices if d.get("device_type") == "GPU"]


async def sample(index: int = 0) -> GpuSample | None:
    """One reading of the live counters.

    Two calls are needed because discovery holds total memory while stats holds
    the live values, and stats does not repeat the total.
    """
    stats, disc = await asyncio.gather(
        _run("stats", "-d", str(index), "-j"),
        _run("discovery", "-d", str(index), "-j"),
    )
    if not isinstance(stats, dict):
        return None

    disc = disc if isinstance(disc, dict) else {}
    total_raw = disc.get("memory_physical_size_byte")
    try:
        total_mib = float(total_raw) / 1024 / 1024 if total_raw is not None else None
    except (TypeError, ValueError):
        total_mib = None

    return GpuSample(
        index=index,
        name=disc.get("device_name") or f"xpu:{index}",
        power_w=_dig(stats, "power", "gpu_power_w", "tile_0", "current"),
        memory_used_mib=_dig(stats, "memory", "used_mib", "tile_0", "current"),
        memory_total_mib=total_mib,
        memory_util_percent=_dig(stats, "memory", "util_percent", "tile_0", "current"),
        frequency_mhz=_dig(stats, "frequency", "gpu_frequency_mhz", "tile_0", "current"),
        # Left as None deliberately on this hardware: xpu-smi reports no
        # temperature sensor for the B70, and inventing a 0 would read as cold.
        temperature_c=_dig(stats, "temperature", "gpu_temperature_c", "tile_0", "current"),
    )


async def sample_dict(index: int = 0) -> dict | None:
    s = await sample(index)
    if s is None:
        return None
    return {**asdict(s), "busy": s.busy}
