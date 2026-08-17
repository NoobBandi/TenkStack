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

# Fields worth surfacing on the device page, grouped the same way the Intel
# provider groups its own.
#
# The grouping is the point. This used to be one flat list rendered as a single
# card of sixteen rows, which in a three-column grid came out as one tall narrow
# column beside two thirds of nothing -- and, worse, meant the two cards on this
# machine could not be read against each other, because "記憶體" on one had no
# counterpart on the other. Same headings, same order, so the eye can move
# between them.
#
# The third element is a unit. nvidia-smi is asked for values without one
# (`--format=nounits`), because a number with its unit glued on cannot be
# compared or formatted; it is put back here, where the row is built.
DETAIL_GROUPS = [
    ("識別", [
        ("name", "型號", ""),
        ("compute_cap", "運算能力", ""),
        ("uuid", "UUID", ""),
        ("serial", "序號", ""),
    ]),
    ("記憶體", [
        ("memory.total", "容量", "MiB"),
        ("clocks.max.memory", "最高時脈", "MHz"),
    ]),
    ("時脈與功耗", [
        ("clocks.max.sm", "最高 SM 時脈", "MHz"),
        ("enforced.power.limit", "功耗上限", "W"),
    ]),
    ("匯流排", [
        ("pci.bus_id", "PCI 位址", ""),
        ("pci.device_id", "裝置 ID", ""),
        ("pcie.link.gen.max", "PCIe 世代", ""),
        ("pcie.link.width.max", "PCIe 通道", ""),
    ]),
    ("驅動與韌體", [
        ("driver_version", "驅動版本", ""),
        ("vbios_version", "VBIOS", ""),
        ("persistence_mode", "持續模式", ""),
    ]),
]

# Flattened once, because nvidia-smi takes one --query-gpu list and the answer
# comes back positionally.
DETAIL_QUERY = [
    (key, label, unit)
    for _, fields in DETAIL_GROUPS
    for key, label, unit in fields
]


def _row_value(raw: str | None, unit: str) -> str | None:
    """One display value, or None for a field this card does not answer.

    nvidia-smi marks an unanswerable field in three ways, and every one of them
    has to become an omitted row rather than a row saying something useless:
    "N/A" for a consumer card with no serial, "[Not Supported]" for a counter
    the silicon lacks, and a bracketed sentence for a query that has been
    deprecated -- `display_mode` answers "[Requested functionality has been
    deprecated]", which is a paragraph where a yes or no belongs.

    The unit is appended here because --format=nounits strips it at the source.
    That is deliberate: a number with its unit glued on cannot be compared or
    reformatted, so it comes back bare and is dressed on the way out.
    """
    if raw is None:
        return None
    text = raw.strip()
    if not text or text.startswith("[") or text.upper().startswith(("N/A", "UNKNOWN")):
        return None
    # A whole number reads better without the decimal nvidia-smi adds to it:
    # the power limit arrives as "170.00".
    if unit and text.endswith(".00"):
        text = text[:-3]
    return f"{text} {unit}" if unit else text


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
        fields = [key for key, _, _ in DETAIL_QUERY]
        rows = await _query(fields, index)
        if not rows:
            return None
        answers = dict(zip(fields, rows[0]))

        groups = []
        for title, spec in DETAIL_GROUPS:
            entries = []
            for key, label, unit in spec:
                value = _row_value(answers.get(key), unit)
                if value is not None:
                    entries.append({"key": key, "label": label, "value": value})
            if entries:
                groups.append({"title": title, "rows": entries})

        return {
            "index": index,
            "name": answers.get("name") or f"gpu:{index}",
            "groups": groups,
            "raw": answers,
        }
