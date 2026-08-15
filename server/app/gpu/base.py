"""What every GPU vendor has to supply, and the shape it arrives in.

The sample below is deliberately vendor-neutral. It was written for Intel, but
nothing in it is Intel-specific: watts, mebibytes, megahertz and degrees mean
the same thing on all three vendors, and each of them reports every field --
NVIDIA and AMD in one command, Intel across xpu-smi and sysfs. Keeping the
console's only GPU type at this level is what makes a second vendor a new file
rather than a new code path through the UI.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

logger = logging.getLogger(__name__)

# Above this fraction of its own maximum clock, a card is doing work.
#
# Vendor-neutral by construction: every vendor reports both the current and the
# maximum clock, and idle sits near a tenth of maximum on all of them (this B70
# idles at 400 of 2800, 14%). Power alone cannot answer the question -- a model
# resident in memory draws power while computing nothing -- which is why the
# clock is the discriminator rather than the wattage.
BUSY_CLOCK_FRACTION = 0.35


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
    # Ceilings the card declares for itself, so the bars and axes drawn against
    # them are calibrated rather than assumed. None when the driver exposes
    # none, in which case the UI falls back to its own estimates.
    power_cap_w: float | None = None
    frequency_max_mhz: float | None = None
    temperature_crit_c: float | None = None
    #: Which vendor produced this reading, so the UI can label mixed systems.
    vendor: str = ""

    @property
    def busy(self) -> bool:
        """Whether the card looks like it is actually working."""
        if self.frequency_mhz is None or not self.frequency_max_mhz:
            return False
        return self.frequency_mhz > self.frequency_max_mhz * BUSY_CLOCK_FRACTION


@runtime_checkable
class Provider(Protocol):
    """One vendor's way of answering the same four questions."""

    key: str
    label: str

    async def discover(self) -> list[dict]:
        """Devices present, each with at least an `index` and a `name`.

        An empty list means "this vendor is not here", which is how the
        selector decides. A provider whose tool is missing must return empty
        rather than raise.
        """

    async def sample(self, index: int) -> GpuSample | None:
        """Live counters for one device."""

    async def detail(self, index: int) -> dict | None:
        """Everything known about one device, grouped for display.

        Groups are vendor-shaped -- an Intel card has sub-slices and an NVIDIA
        one has SM counts -- so each provider owns its own field list rather
        than forcing a common schema on facts that are not common.
        """


async def run(*args: str, timeout: float = 5.0) -> tuple[int, str]:
    """Run a vendor CLI, returning its exit code and output.

    Failures are returned rather than raised: a missing tool is the normal
    answer on two of the three vendors, and it must not become an exception
    that the poller has to catch every two seconds.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except (FileNotFoundError, PermissionError):
        return 127, ""

    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        logger.warning("%s timed out after %.0fs", args[0], timeout)
        return 124, ""

    if proc.returncode:
        return proc.returncode, err.decode(errors="replace")
    return 0, out.decode(errors="replace")


def to_float(value: object) -> float | None:
    """Tolerant numeric read.

    Vendor CLIs mark a field they cannot measure in several ways -- "N/A",
    "[Not Supported]", an empty string, an unsigned -1 -- and every one of them
    has to become None rather than a number that would be drawn on a chart.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        text = str(value).strip()
        if not text or text.upper().startswith(("N/A", "[NOT", "UNKNOWN")):
            return None
        try:
            number = float(text.split()[0])
        except (ValueError, IndexError):
            return None
    # 4294967295 is an unsigned -1, which xpu-smi uses for "unknown".
    if number in (4294967295.0,):
        return None
    return number
