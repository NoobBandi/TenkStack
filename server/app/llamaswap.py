"""Client for llama-swap.

Two responsibilities, deliberately kept apart:

- reading state, which comes entirely from the SSE stream at /api/events, so
  nothing here polls;
- changing state, which is done by rewriting config.yaml and letting
  llama-swap's -watch-config pick it up. There is no management API for adding
  models, and the config file is the single source of truth anyway.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import AsyncIterator

import httpx
from httpx_sse import aconnect_sse

logger = logging.getLogger(__name__)

BASE_URL = "http://127.0.0.1:8080"
CONFIG_PATH = "/home/tenk/ai/llama-swap/config.yaml"

# llama-server prints its own timings to stderr, which llama-swap forwards as
# logData. This is the only place real throughput is reported, so it is parsed
# out rather than left buried in the log pane.
_EVAL_TIMING = re.compile(
    r"eval time =\s*([\d.]+) ms /\s*(\d+) tokens.*?([\d.]+) tokens per second"
)


async def get_running() -> list[dict]:
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=5) as client:
        try:
            resp = await client.get("/running")
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            logger.warning("llama-swap /running failed: %s", exc)
            return []
    return resp.json().get("running", [])


async def get_props(proxy: str) -> dict | None:
    """llama-server's own description of what it loaded.

    This is the authoritative answer for multimodality: `modalities.vision` is
    true only when an mmproj was actually loaded, which config inspection alone
    cannot confirm -- a `--mmproj` pointing at a missing file still appears in
    the command line.
    """
    async with httpx.AsyncClient(base_url=proxy, timeout=5) as client:
        try:
            resp = await client.get("/props")
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            logger.debug("props unavailable at %s: %s", proxy, exc)
            return None
    return resp.json()


async def list_models() -> list[dict]:
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=5) as client:
        try:
            resp = await client.get("/v1/models")
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            logger.warning("llama-swap /v1/models failed: %s", exc)
            return []
    return resp.json().get("data", [])


async def unload_all() -> bool:
    """Unload every resident model. Note llama-swap accepts GET here, not POST."""
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=30) as client:
        try:
            resp = await client.get("/unload")
            return resp.status_code == 200
        except httpx.HTTPError as exc:
            logger.warning("llama-swap /unload failed: %s", exc)
            return False


def _parse_frame(payload: str) -> dict | None:
    """Unwrap one SSE frame.

    The payload is double-encoded: the outer object's `data` field is a JSON
    *string* that has to be parsed a second time. Frames that do not follow that
    shape are dropped rather than guessed at.
    """
    try:
        outer = json.loads(payload)
    except json.JSONDecodeError:
        return None

    kind = outer.get("type")
    inner_raw = outer.get("data")
    if not kind:
        return None

    inner: object = inner_raw
    if isinstance(inner_raw, str):
        try:
            inner = json.loads(inner_raw)
        except json.JSONDecodeError:
            inner = inner_raw

    return {"type": kind, "data": inner}


def extract_throughput(event: dict) -> dict | None:
    """Pull tokens/sec out of an upstream log frame, if it carries one."""
    if event.get("type") != "logData":
        return None
    data = event.get("data")
    text = data.get("data") if isinstance(data, dict) else data
    if not isinstance(text, str):
        return None
    match = _EVAL_TIMING.search(text)
    if not match:
        return None
    return {
        "eval_ms": float(match.group(1)),
        "tokens": int(match.group(2)),
        "tokens_per_second": float(match.group(3)),
    }


async def events() -> AsyncIterator[dict]:
    """Yield llama-swap events forever, reconnecting when the stream drops.

    llama-swap restarting must not take the console's stream down with it, so a
    failed connection backs off and retries instead of propagating.
    """
    backoff = 1.0
    while True:
        try:
            async with httpx.AsyncClient(base_url=BASE_URL, timeout=None) as client:
                async with aconnect_sse(client, "GET", "/api/events") as source:
                    backoff = 1.0
                    async for sse in source.aiter_sse():
                        event = _parse_frame(sse.data)
                        if event is None:
                            continue
                        throughput = extract_throughput(event)
                        if throughput:
                            yield {"type": "throughput", "data": throughput}
                        yield event
        except (httpx.HTTPError, asyncio.TimeoutError) as exc:
            logger.warning("llama-swap event stream lost (%s); retrying in %.0fs", exc, backoff)
        except Exception:
            logger.exception("unexpected error on llama-swap event stream")

        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 30.0)
