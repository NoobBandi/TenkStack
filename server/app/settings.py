"""The console's own knobs, and where they live.

Everything here was a constant in the source until it was not. That is the
right place for a number nobody will ever change, and the wrong one for a
number somebody has already asked about -- the agent's step limit was the first,
and the answer at the time was to edit a TypeScript file and rebuild.

What belongs here is narrow. A value is a setting when a reasonable owner of
this machine would want it different and nothing else in the console can derive
it. Which cards exist, which containers are running, where a model is served
from: none of those are settings, they are facts, and the pages that show them
read the machine instead. Putting a fact in a settings table is how a console
starts disagreeing with the box it runs on.

Defaults live in the spec below rather than in the database, so an install that
has never opened this page behaves exactly as it did before there was a table,
and clearing a row restores the behaviour rather than zeroing it.
"""

from __future__ import annotations

import logging
import sqlite3

from . import paths

logger = logging.getLogger(__name__)

DB_PATH = paths.DB_PATH

# name -> the whole of what the UI needs to render and validate it.
#
# `unit` is a display suffix; `minimum` and `maximum` are enforced here rather
# than in the browser, because the API is reachable without it.
SPEC: dict[str, dict] = {
    "agent_max_steps": {
        "label": "Agent 步數上限",
        "note": "一次回答裡最多執行幾次工具。到達上限時最後一輪不再執行，改為要求模型直接作答。",
        "default": 8, "minimum": 1, "maximum": 32, "unit": "步",
        "group": "chat",
    },
    "estimate_depth": {
        "label": "速度預估的對話深度",
        "note": "模型目錄預估 tok/s 時假設的快取深度。生成會隨快取變長而變慢，所以這個數字決定預估落在哪一段。",
        "default": 4096, "minimum": 256, "maximum": 131072, "unit": "token",
        "group": "chat",
    },
    "vram_margin_gib": {
        "label": "顯存餘裕",
        "note": "判斷是否要為模型清出顯示卡時，加在模型檔案大小上的緩衝。KV 快取與計算緩衝不在檔案大小裡。",
        "default": 4, "minimum": 0, "maximum": 32, "unit": "GiB",
        "group": "vram",
    },
    "comfyui_idle_gib": {
        "label": "ComfyUI 閒置門檻",
        "note": "低於這個佔用量就當作 ComfyUI 沒有擋路——閒置的實例本來就會留著幾百 MB 的緩衝。",
        "default": 1, "minimum": 0, "maximum": 16, "unit": "GiB",
        "group": "vram",
    },
    "log_lines": {
        "label": "日誌保留行數",
        "note": "伺服器端環形緩衝的大小。日誌頁往回捲的距離就到這裡為止。",
        "default": 4000, "minimum": 200, "maximum": 50000, "unit": "行",
        "group": "history",
    },
    "gpu_history_hours": {
        "label": "GPU 歷史時長",
        "note": "顯示卡取樣保留多久。每兩秒一筆，時間拉長只換到更多記憶體。",
        "default": 2, "minimum": 1, "maximum": 24, "unit": "小時",
        "group": "history",
    },
}

_cache: dict[str, int] | None = None


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                name  TEXT PRIMARY KEY,
                value INTEGER NOT NULL
            )
            """
        )


def _load() -> dict[str, int]:
    global _cache
    if _cache is None:
        try:
            with _connect() as conn:
                rows = conn.execute("SELECT name, value FROM settings").fetchall()
            _cache = {row["name"]: int(row["value"]) for row in rows if row["name"] in SPEC}
        except sqlite3.Error:
            logger.exception("could not read settings; using defaults")
            _cache = {}
    return _cache


def get(name: str) -> int:
    """One setting, or its default.

    Read at the point of use rather than at import, so a change takes effect
    without a restart -- which is the whole difference between this and the
    constants it replaced.
    """
    spec = SPEC[name]
    return _load().get(name, spec["default"])


def all_values() -> dict[str, int]:
    return {name: get(name) for name in SPEC}


def describe() -> list[dict]:
    """The spec joined with the current values, for the page to render."""
    return [
        {"name": name, "value": get(name), **spec}
        for name, spec in SPEC.items()
    ]


def save(values: dict) -> dict[str, int]:
    """Write the settings named, leaving the rest alone.

    A value equal to its default deletes the row instead of storing it. The
    table then holds only what somebody actually changed, which is what makes
    it readable and what makes a later change of default reach the installs
    that never expressed an opinion.
    """
    global _cache
    clean: dict[str, int] = {}
    for name, raw in values.items():
        spec = SPEC.get(name)
        if spec is None:
            raise ValueError(f"沒有這個設定：{name}")
        try:
            number = int(raw)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{spec['label']} 需要一個整數") from exc
        if not spec["minimum"] <= number <= spec["maximum"]:
            raise ValueError(
                f"{spec['label']} 要在 {spec['minimum']} 到 {spec['maximum']} 之間"
            )
        clean[name] = number

    with _connect() as conn:
        for name, number in clean.items():
            if number == SPEC[name]["default"]:
                conn.execute("DELETE FROM settings WHERE name = ?", (name,))
            else:
                conn.execute(
                    "INSERT INTO settings (name, value) VALUES (?, ?) "
                    "ON CONFLICT(name) DO UPDATE SET value = excluded.value",
                    (name, number),
                )
    _cache = None
    logger.info("settings saved: %s", clean)
    return all_values()
