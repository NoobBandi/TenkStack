"""AMD, through amd-smi with rocm-smi as the fallback.

Two tools because ROCm changed hands mid-stream: amd-smi is the current one and
ships with ROCm 6 and later, rocm-smi is what older installs have. They disagree
about almost everything -- command names, JSON shape, units -- so each gets its
own reader and the newer one is tried first.

UNVERIFIED. Written against the documented JSON of both tools; there is no AMD
card on the machine this was developed on, so it has never produced a real
reading. The digging below is deliberately tolerant of missing keys, because the
exact nesting differs between ROCm point releases and a wrong guess should
surface as a blank field rather than a crash.
"""

from __future__ import annotations

import json
import logging
import shutil

from .base import GpuSample, run, to_float

logger = logging.getLogger(__name__)

AMD_SMI = shutil.which("amd-smi") or "amd-smi"
ROCM_SMI = shutil.which("rocm-smi") or "rocm-smi"


def _dig(obj: object, *names: str) -> object:
    """First value found under any of `names`, at any depth.

    A path would be more precise, but the same reading sits at different depths
    between amd-smi releases -- `power.socket_power` in one,
    `power_info.socket_power` in the next. Searching by key name survives that
    where a fixed path does not.
    """
    if isinstance(obj, dict):
        for name in names:
            if name in obj:
                return obj[name]
        for value in obj.values():
            found = _dig(value, *names)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for value in obj:
            found = _dig(value, *names)
            if found is not None:
                return found
    return None


async def _amd_json(*args: str) -> object | None:
    code, out = await run(AMD_SMI, *args, "--json")
    if code:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return None


async def _rocm_json(*args: str) -> dict | None:
    code, out = await run(ROCM_SMI, *args, "--json")
    if code:
        return None
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _entry_for(payload: object, index: int) -> object:
    """One device out of a payload that may be a list or a keyed object."""
    if isinstance(payload, list):
        for item in payload:
            if isinstance(item, dict) and to_float(_dig(item, "gpu", "gpu_id")) == index:
                return item
        return payload[index] if index < len(payload) else None
    if isinstance(payload, dict):
        # rocm-smi keys by "card0", "card1", ...
        for key in (f"card{index}", str(index)):
            if key in payload:
                return payload[key]
    return payload


class Amd:
    key = "amd"
    label = "AMD (amd-smi)"

    async def discover(self) -> list[dict]:
        payload = await _amd_json("static", "--asic")
        if payload is not None:
            items = payload if isinstance(payload, list) else [payload]
            out = []
            for position, item in enumerate(items):
                gpu_id = to_float(_dig(item, "gpu", "gpu_id"))
                out.append({
                    "index": int(gpu_id) if gpu_id is not None else position,
                    "name": str(_dig(item, "market_name", "product_name") or f"gpu:{position}"),
                    "drm_device": None,
                    "pci_bdf_address": _dig(item, "bdf", "pci_bus"),
                    "state": None,
                    "raw": item if isinstance(item, dict) else {},
                })
            return out

        legacy = await _rocm_json("--showproductname")
        if not legacy:
            return []
        out = []
        for position, (key, item) in enumerate(sorted(legacy.items())):
            out.append({
                "index": position,
                "name": str(_dig(item, "Card series", "Card model") or key),
                "drm_device": None,
                "pci_bdf_address": _dig(item, "PCI Bus"),
                "state": None,
                "raw": item if isinstance(item, dict) else {},
            })
        return out

    async def sample(self, index: int) -> GpuSample | None:
        metric = await _amd_json("metric", "--gpu", str(index))
        static = await _amd_json("static", "--gpu", str(index))
        if metric is None and static is None:
            return await self._sample_legacy(index)

        m = _entry_for(metric, index)
        s = _entry_for(static, index)

        used = to_float(_dig(m, "used_vram", "vram_used"))
        total = to_float(_dig(s, "total_vram", "vram_total")) or to_float(_dig(m, "total_vram"))

        return GpuSample(
            index=index,
            name=str(_dig(s, "market_name", "product_name") or f"gpu:{index}"),
            power_w=to_float(_dig(m, "socket_power", "average_socket_power", "power")),
            memory_used_mib=used,
            memory_total_mib=total,
            memory_util_percent=(used / total * 100) if used and total else None,
            frequency_mhz=to_float(_dig(m, "gfxclk", "sclk", "gfx_clk")),
            temperature_c=to_float(_dig(m, "edge", "hotspot", "junction", "temperature")),
            power_cap_w=to_float(_dig(s, "power_cap", "socket_power_cap")),
            frequency_max_mhz=to_float(_dig(s, "max_gfxclk", "sclk_max")),
            temperature_crit_c=to_float(_dig(s, "hotspot_limit", "temp_limit")),
            vendor=self.key,
        )

    async def _sample_legacy(self, index: int) -> GpuSample | None:
        data = await _rocm_json(
            "--showpower", "--showmemuse", "--showtemp", "--showgpuclocks", "--showproductname",
        )
        if not data:
            return None
        item = _entry_for(data, index)
        if item is None:
            return None

        used = to_float(_dig(item, "VRAM Total Used Memory (B)"))
        total = to_float(_dig(item, "VRAM Total Memory (B)"))
        return GpuSample(
            index=index,
            name=str(_dig(item, "Card series", "Card model") or f"gpu:{index}"),
            power_w=to_float(_dig(item, "Average Graphics Package Power (W)")),
            memory_used_mib=used / 1024 / 1024 if used else None,
            memory_total_mib=total / 1024 / 1024 if total else None,
            memory_util_percent=(used / total * 100) if used and total else None,
            frequency_mhz=to_float(_dig(item, "sclk clock speed:", "sclk")),
            temperature_c=to_float(_dig(item, "Temperature (Sensor edge) (C)")),
            vendor=self.key,
        )

    async def detail(self, index: int) -> dict | None:
        payload = await _amd_json("static", "--gpu", str(index))
        item = _entry_for(payload, index) if payload is not None else None
        if not isinstance(item, dict):
            legacy = await _rocm_json("--showallinfo")
            item = _entry_for(legacy, index) if legacy else None
        if not isinstance(item, dict):
            return None

        rows = []
        for key, value in item.items():
            if isinstance(value, (dict, list)):
                continue
            text = str(value).strip()
            if not text or text.upper().startswith(("N/A", "[NOT")):
                continue
            rows.append({"key": key, "label": key.replace("_", " "), "value": text})

        return {
            "index": index,
            "name": str(_dig(item, "market_name", "product_name") or f"gpu:{index}"),
            "groups": [{"title": "裝置", "rows": rows}] if rows else [],
            "raw": item,
        }
