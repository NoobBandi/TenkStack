"""Intel Arc, through xpu-smi and the parts of sysfs it does not cover.

The most awkward of the three. xpu-smi answers in JSON but omits three things
the console draws against -- the sustained power cap, the maximum clock, and any
temperature at all on Battlemage -- while the driver publishes all of them under
the PCI device. So a reading here is two sources merged, where NVIDIA and AMD
each need one command.

Located by PCI address rather than DRM index, because card numbering is assigned
in probe order and would not reliably line up with xpu-smi's own device ids once
a second card is installed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
from pathlib import Path

from .base import GpuSample, run, to_float

logger = logging.getLogger(__name__)

BIN = shutil.which("xpu-smi") or "/usr/bin/xpu-smi"

# Fields worth surfacing on the device page, in the order they are shown.
DETAIL_GROUPS = [
    ("識別", [
        ("device_name", "型號"),
        ("vendor_name", "廠商"),
        ("device_type", "類型"),
        ("sku_type", "SKU"),
        ("device_stepping", "步進"),
        ("serial_number", "序號"),
        ("uuid", "UUID"),
    ]),
    ("運算單元", [
        ("number_of_eus", "執行單元 (EU)"),
        ("number_of_slices", "Slice"),
        ("number_of_sub_slices_per_slice", "每 Slice 的 Sub-slice"),
        ("number_of_eus_per_sub_slice", "每 Sub-slice 的 EU"),
        ("number_of_threads_per_eu", "每 EU 執行緒"),
        ("physical_eu_simd_width", "SIMD 寬度"),
        ("core_clock_rate", "核心時脈"),
        ("number_of_tiles", "Tile"),
    ]),
    ("記憶體", [
        ("memory_physical_size", "容量"),
        ("max_mem_alloc_size_byte", "單次配置上限"),
        ("memory_bus_width", "匯流排寬度"),
        ("number_of_memory_channels", "通道數"),
        ("memory_ecc_state", "ECC"),
    ]),
    ("媒體引擎", [
        ("number_of_media_engines", "媒體引擎"),
        ("number_of_media_enh_engines", "媒體加強引擎"),
    ]),
    ("驅動與韌體", [
        ("drm_device", "DRM 裝置"),
        ("driver_version", "驅動版本"),
        ("kernel_version", "核心版本"),
        ("gfx_firmware_name", "韌體"),
        ("gfx_firmware_version", "韌體版本"),
        ("gfx_firmware_status", "韌體狀態"),
        ("device_state", "狀態"),
    ]),
]

# xpu-smi reports some fields as sentinels rather than omitting them: an
# unsigned -1 for an unknown bus width, 0 for free memory it does not track.
# Filtered out rather than displayed, because a wrong number is worse than a
# blank.
_UNKNOWN = {"", "N/A", "unknown", "0", 4294967295, "4294967295"}


# Fields xpu-smi reports in a form nobody reads.
#
# `max_mem_alloc_size_byte` comes back as 32530182144, which is a number you
# have to divide by 1024 three times before it says anything, and it sits two
# rows under a capacity already given in MiB. `driver_version` is 17012470,
# which is not a version anybody quotes -- it is the i915/xe build id packed
# into an integer, and the useful thing to say about it is the number itself
# with no pretence that it is comparable to 595.84 on the card beside it.
def _readable(key: str, value: object) -> str:
    text = str(value)
    if key == "max_mem_alloc_size_byte":
        number = to_float(text)
        if number:
            return f"{number / 1024 ** 3:.2f} GiB"
    if key == "core_clock_rate" and text.isdigit():
        return f"{text} MHz"
    return text


async def _json(*args: str) -> dict | list | None:
    code, out = await run(BIN, *args)
    if code:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return None


def _dig(obj: dict | None, *path: str) -> float | None:
    """Walk a path of dict keys, returning None if any step is missing.

    The stats payload nests per-tile: power.gpu_power_w.tile_0.current. Single-
    tile cards still use tile_0, so the path is uniform, but a field the
    hardware does not report is simply absent rather than null.
    """
    cur: object = obj
    for key in path:
        if not isinstance(cur, dict) or key not in cur:
            return None
        cur = cur[key]
    return to_float(cur)


def _read_int(path: Path) -> int | None:
    try:
        return int(path.read_text().strip())
    except (OSError, ValueError):
        return None


def _sysfs(bdf: str | None) -> dict:
    """Limits and sensors the kernel exposes but xpu-smi does not."""
    if not bdf:
        return {}
    root = Path("/sys/bus/pci/devices") / bdf
    if not root.is_dir():
        return {}

    out: dict = {}

    for hwmon in sorted(root.glob("hwmon/hwmon*")):
        cap = _read_int(hwmon / "power1_cap")
        if cap is not None:
            out["power_cap_w"] = cap / 1_000_000  # microwatts

        # Many sensors are exposed -- package, VRAM, PCIe, and one per memory
        # channel. The package reading is the die itself, which is the one worth
        # showing; the rest would be a wall of numbers.
        for label_path in sorted(hwmon.glob("temp*_label")):
            try:
                if label_path.read_text().strip() != "pkg":
                    continue
            except OSError:
                continue
            stem = str(label_path)[: -len("_label")]
            value = _read_int(Path(f"{stem}_input"))
            crit = _read_int(Path(f"{stem}_crit"))
            if value is not None:
                out["temperature_c"] = value / 1000  # millidegrees
            if crit is not None:
                out["temperature_crit_c"] = crit / 1000
            break
        if out:
            break

    freq_max = _read_int(root / "tile0/gt0/freq0/rp0_freq")
    if freq_max is not None:
        out["frequency_max_mhz"] = float(freq_max)

    return out


class Intel:
    key = "intel"
    label = "Intel (xpu-smi)"

    def __init__(self) -> None:
        # Discovery describes the card, not its state, and none of it changes
        # while the machine is up. It was being re-read twice a second beside
        # the live counters -- and every xpu-smi invocation writes a dozen lines
        # of MEI permission errors straight to syslog, which came to over a
        # million journal lines a day.
        self._static: dict[int, dict] = {}

    async def discover(self) -> list[dict]:
        data = await _json("discovery", "-j")
        if not isinstance(data, dict):
            return []
        devices = [d for d in data.get("device_list", []) if d.get("device_type") == "GPU"]
        return [{
            "index": d.get("device_id", 0),
            "name": d.get("device_name"),
            "drm_device": d.get("drm_device"),
            "pci_bdf_address": d.get("pci_bdf_address"),
            "state": d.get("device_state"),
            "raw": d,
        } for d in devices]

    async def _static_for(self, index: int) -> dict:
        cached = self._static.get(index)
        if cached is not None:
            return cached
        fresh = await _json("discovery", "-d", str(index), "-j")
        if isinstance(fresh, dict):
            self._static[index] = fresh
            return fresh
        return {}

    async def sample(self, index: int) -> GpuSample | None:
        if index in self._static:
            stats = await _json("stats", "-d", str(index), "-j")
            disc = self._static[index]
        else:
            stats, disc = await asyncio.gather(
                _json("stats", "-d", str(index), "-j"),
                self._static_for(index),
            )
        if not isinstance(stats, dict):
            return None
        disc = disc if isinstance(disc, dict) else {}

        total_mib = None
        total_raw = to_float(disc.get("memory_physical_size_byte"))
        if total_raw:
            total_mib = total_raw / 1024 / 1024

        extra = _sysfs(disc.get("pci_bdf_address") or stats.get("pci_bdf"))

        return GpuSample(
            index=index,
            name=disc.get("device_name") or f"xpu:{index}",
            power_w=_dig(stats, "power", "gpu_power_w", "tile_0", "current"),
            memory_used_mib=_dig(stats, "memory", "used_mib", "tile_0", "current"),
            memory_total_mib=total_mib,
            memory_util_percent=_dig(stats, "memory", "util_percent", "tile_0", "current"),
            frequency_mhz=_dig(stats, "frequency", "gpu_frequency_mhz", "tile_0", "current"),
            # xpu-smi has no temperature section for this card, but the driver
            # does publish one; sysfs is the fallback rather than the other way
            # round, so a card that reports through xpu-smi keeps using it.
            temperature_c=(
                _dig(stats, "temperature", "gpu_temperature_c", "tile_0", "current")
                or extra.get("temperature_c")
            ),
            power_cap_w=extra.get("power_cap_w"),
            frequency_max_mhz=extra.get("frequency_max_mhz"),
            temperature_crit_c=extra.get("temperature_crit_c"),
            vendor=self.key,
        )

    async def detail(self, index: int) -> dict | None:
        raw = await self._static_for(index)
        if not raw:
            return None

        groups = []
        for title, fields in DETAIL_GROUPS:
            rows = []
            for key, label in fields:
                value = raw.get(key)
                if value is None or value in _UNKNOWN:
                    continue
                rows.append({"key": key, "label": label, "value": _readable(key, value)})
            if rows:
                groups.append({"title": title, "rows": rows})

        return {"index": index, "name": raw.get("device_name"), "groups": groups, "raw": raw}
