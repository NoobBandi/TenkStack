"""NVIDIA, through nvidia-smi.

The easiest of the three: a single `--query-gpu` call returns every field this
console draws, in CSV, with units stripped. No sysfs, no second command, no
per-tile nesting.

UNVERIFIED. Written against nvidia-smi's documented query fields; there is no
NVIDIA card on the machine this was developed on, so it has never produced a
real reading. The field names are stable across driver versions and the parsing
is defensive, but treat a first run as a test rather than as working code.
"""

from __future__ import annotations

import logging
import shutil

from .base import GpuSample, run, to_float

logger = logging.getLogger(__name__)

BIN = shutil.which("nvidia-smi") or "nvidia-smi"

# Order matters: it is the column order of the reply.
#
# `enforced.power.limit` rather than `power.limit`: the former is what the card
# will actually hold itself to, which is the ceiling a bar should be drawn
# against. `clocks.max.sm` gives the busy heuristic its denominator.
QUERY = [
    "index",
    "name",
    "power.draw",
    "enforced.power.limit",
    "memory.used",
    "memory.total",
    "utilization.memory",
    "clocks.current.sm",
    "clocks.max.sm",
    "temperature.gpu",
    "temperature.gpu.tlimit",
]

DETAIL_QUERY = [
    ("name", "型號"),
    ("uuid", "UUID"),
    ("serial", "序號"),
    ("pci.bus_id", "PCI 位址"),
    ("pci.device_id", "裝置 ID"),
    ("driver_version", "驅動版本"),
    ("vbios_version", "VBIOS"),
    ("compute_cap", "運算能力"),
    ("memory.total", "顯存容量"),
    ("enforced.power.limit", "功耗上限"),
    ("clocks.max.sm", "最高 SM 時脈"),
    ("clocks.max.memory", "最高記憶體時脈"),
    ("pcie.link.gen.max", "PCIe 世代"),
    ("pcie.link.width.max", "PCIe 通道"),
    ("display_mode", "顯示輸出"),
    ("persistence_mode", "持續模式"),
]


async def _query(fields: list[str], index: int | None = None) -> list[list[str]]:
    args = [
        BIN,
        f"--query-gpu={','.join(fields)}",
        "--format=csv,noheader,nounits",
    ]
    if index is not None:
        args.append(f"--id={index}")
    code, out = await run(*args)
    if code:
        return []
    rows = []
    for line in out.splitlines():
        if not line.strip():
            continue
        rows.append([cell.strip() for cell in line.split(",")])
    return rows


class Nvidia:
    key = "nvidia"
    label = "NVIDIA (nvidia-smi)"

    async def discover(self) -> list[dict]:
        rows = await _query(["index", "name", "pci.bus_id", "uuid"])
        out = []
        for row in rows:
            if len(row) < 2:
                continue
            index = to_float(row[0])
            out.append({
                "index": int(index) if index is not None else 0,
                "name": row[1],
                "drm_device": None,
                "pci_bdf_address": row[2] if len(row) > 2 else None,
                "state": None,
                "raw": {"uuid": row[3] if len(row) > 3 else None},
            })
        return out

    async def sample(self, index: int) -> GpuSample | None:
        rows = await _query(QUERY, index)
        if not rows:
            return None
        row = rows[0]
        if len(row) < len(QUERY):
            # A field the driver does not support comes back short rather than
            # empty on some versions; pad so the positional reads below hold.
            row = row + [""] * (len(QUERY) - len(row))

        used = to_float(row[4])
        total = to_float(row[5])
        return GpuSample(
            index=index,
            name=row[1] or f"gpu:{index}",
            power_w=to_float(row[2]),
            memory_used_mib=used,
            memory_total_mib=total,
            # nvidia-smi's utilization.memory is the fraction of time the memory
            # bus was busy, not how full the memory is -- a different quantity
            # from the one this field means everywhere else in the console.
            memory_util_percent=(used / total * 100) if used and total else None,
            frequency_mhz=to_float(row[7]),
            temperature_c=to_float(row[9]),
            power_cap_w=to_float(row[3]),
            frequency_max_mhz=to_float(row[8]),
            temperature_crit_c=to_float(row[10]),
            vendor=self.key,
        )

    async def detail(self, index: int) -> dict | None:
        fields = [key for key, _ in DETAIL_QUERY]
        rows = await _query(fields, index)
        if not rows:
            return None
        values = rows[0]

        entries = []
        for (key, label), value in zip(DETAIL_QUERY, values):
            text = value.strip()
            if not text or text.upper().startswith(("N/A", "[NOT")):
                continue
            entries.append({"key": key, "label": label, "value": text})

        name = next((e["value"] for e in entries if e["key"] == "name"), f"gpu:{index}")
        return {
            "index": index,
            "name": name,
            "groups": [{"title": "裝置", "rows": entries}] if entries else [],
            "raw": dict(zip(fields, values)),
        }
