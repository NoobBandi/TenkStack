"""Per-request history, read out of llama-swap's own store.

llama-swap already writes a row for every request it proxies -- config.yaml
points its `store` at activity.sqlite -- so nothing here collects anything. It
would be a second, worse copy of a record that already exists.

The column this module exists for is `cache_tokens`: how deep into the context
window a request started. Plotted against `tokens_per_second` it is the shape
of the thing that actually hurts on one card -- generation slows roughly
linearly with depth, and a session that drifts past the knee gets slow long
before it hits the ceiling.

Opened read-only, and per call rather than held: it is another process's
database, and a connection this one keeps open is a connection llama-swap can
be blocked behind.
"""

from __future__ import annotations

import logging
import sqlite3

from . import paths

logger = logging.getLogger(__name__)

#: Below this a row says nothing about sustained speed -- a handful of tokens is
#: all warm-up, and the rate it reports is noise that would smear the trend.
MIN_OUTPUT_TOKENS = 20


def recent(limit: int = 400, model_id: str | None = None) -> list[dict]:
    """Completed requests, newest first, that carry a usable rate."""
    if not paths.LLAMA_SWAP_ACTIVITY.exists():
        return []

    sql = """
        SELECT ts_created, model_id, input_tokens, output_tokens, cache_tokens,
               prompt_per_second, tokens_per_second, duration_ms, resp_status_code
        FROM activity
        WHERE output_tokens >= ? AND tokens_per_second > 0
    """
    params: list[object] = [MIN_OUTPUT_TOKENS]
    if model_id:
        sql += " AND model_id = ?"
        params.append(model_id)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(limit)

    try:
        uri = f"file:{paths.LLAMA_SWAP_ACTIVITY}?mode=ro"
        with sqlite3.connect(uri, uri=True, timeout=2) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(sql, params).fetchall()
    except sqlite3.Error as exc:
        # A missing table is the normal state on a llama-swap started without a
        # store, and a locked file is the normal state while it writes. Neither
        # is worth failing a dashboard over.
        logger.debug("activity unavailable: %s", exc)
        return []

    return [
        {
            "ts": row["ts_created"],
            "model": row["model_id"],
            "input": row["input_tokens"] or 0,
            "output": row["output_tokens"] or 0,
            # What the window already held when this request began. The x axis.
            "depth": row["cache_tokens"] or 0,
            "prompt_per_second": row["prompt_per_second"] or 0.0,
            "tokens_per_second": row["tokens_per_second"] or 0.0,
            "duration_ms": row["duration_ms"] or 0,
            "status": row["resp_status_code"],
        }
        for row in rows
    ]


def last_used() -> str | None:
    """The model id of the most recent request, or None if there is no history.

    For the connections page, which hands out a config file naming one model.
    Naming whichever entry happens to sort first is wrong twice over: it is not
    what the reader is using, and it changes when the config is reordered. The
    running model is the right answer while something is loaded; this is the
    fallback for a cold box, and it is a better guess than the first entry
    because it is the one that was last worth loading.
    """
    if not paths.LLAMA_SWAP_ACTIVITY.exists():
        return None
    try:
        uri = f"file:{paths.LLAMA_SWAP_ACTIVITY}?mode=ro"
        with sqlite3.connect(uri, uri=True, timeout=2) as conn:
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT model_id FROM activity "
                "WHERE model_id IS NOT NULL AND model_id != '' "
                "ORDER BY id DESC LIMIT 1"
            ).fetchone()
    except sqlite3.Error as exc:
        logger.debug("activity unavailable: %s", exc)
        return None
    return row["model_id"] if row else None
