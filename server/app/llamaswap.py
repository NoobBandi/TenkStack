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
import time
import json
import logging
import re
from typing import AsyncIterator

import httpx
from httpx_sse import aconnect_sse
from . import paths

logger = logging.getLogger(__name__)

BASE_URL = "http://127.0.0.1:8080"
CONFIG_PATH = str(paths.LLAMA_SWAP_CONFIG)

# llama-server prints its own timings to stderr, which llama-swap forwards as
# logData. This is the only place real throughput is reported, so it is parsed
# out rather than left buried in the log pane.
_EVAL_TIMING = re.compile(
    r"eval time =\s*([\d.]+) ms /\s*(\d+) tokens.*?([\d.]+) tokens per second"
)


# The per-tick progress llama-server prints while a request is in flight, which
# is what a curve needs and the summary above cannot give: the summary arrives
# once, at the end.
#
# Two phases, two shapes. Prefill counts the prompt it has ingested so far and
# reports the rate it is ingesting at; decode counts what it has generated and
# reports both a cumulative average (tg) and a three-second window (tg_3s). The
# window is the useful one -- the average is dragged by however the request
# started and stops moving once it is long.
#
# `n_gen` and `n_decoded` are the same field under two names, emitted by
# different builds and by the speculative path; both are accepted rather than
# guessing which one this server uses.
_PREFILL_TICK = re.compile(
    r"print_timing: id\s+(\d+) \| task (\d+) \| prompt processing, "
    r"n_tokens =\s*(\d+), progress = ([\d.]+), t =\s*([\d.]+) s / ([\d.]+) tokens per second"
)
_DECODE_TICK = re.compile(
    r"print_timing: id\s+(\d+) \| task (\d+) \| (?:n_gen|n_decoded) =\s*(\d+), "
    r"tg =\s*([\d.]+) t/s, tg_3s =\s*([\d.]+) t/s"
)
_RELEASE = re.compile(
    r"slot\s+release: id\s+(\d+) \| task (\d+) \| stop processing: "
    r"n_tokens = (\d+), truncated = (\d+)"
)


def extract_progress(event: dict) -> dict | None:
    """One tick of a request's lifecycle, or nothing.

    Slot and task are both carried because neither identifies a request on its
    own: a slot is reused by whatever comes next, and task ids restart when the
    server does. The pair is what a chart can key a series on.
    """
    if event.get("type") != "logData":
        return None
    data = event.get("data")
    text = data.get("data") if isinstance(data, dict) else data
    if not isinstance(text, str):
        return None

    if (m := _DECODE_TICK.search(text)):
        return {
            "slot": int(m.group(1)), "task": int(m.group(2)), "phase": "decode",
            "tokens": int(m.group(3)),
            # tg_3s, not tg: the window is what shows a request slowing down.
            "rate": float(m.group(5)),
            "average": float(m.group(4)),
        }

    if (m := _PREFILL_TICK.search(text)):
        return {
            "slot": int(m.group(1)), "task": int(m.group(2)), "phase": "prefill",
            "tokens": int(m.group(3)), "progress": float(m.group(4)),
            "elapsed": float(m.group(5)), "rate": float(m.group(6)),
        }

    if (m := _RELEASE.search(text)):
        return {
            "slot": int(m.group(1)), "task": int(m.group(2)), "phase": "done",
            # The whole window this request ended up occupying, prompt included --
            # not the count it generated. Truncated means it ran into that ceiling
            # mid-reply, which is the failure worth seeing on a chart.
            "tokens": int(m.group(3)),
            "truncated": m.group(4) != "0",
        }

    return None


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


async def get_slots(proxy: str) -> list[dict] | None:
    """How full each of a running model's slots is, right now.

    The point of this is the wall a coding agent walks into: a slot that fills
    to n_ctx truncates mid-reply, and a reply truncated inside a tool call
    leaves JSON the client will replay -- and llama.cpp will reject -- on every
    turn after. Nothing in /running or /props says how close a slot is to that,
    so it is asked for directly.

    Only the counters are carried out of here. llama-server's /slots also
    returns each slot's prompt text, which is the whole conversation of
    whoever is using it; the console has no business relaying that to a
    dashboard, so the fields are picked rather than passed through.

    None when the endpoint is unavailable -- it is 501 on a server started with
    --no-slots -- which the caller shows as "unknown" rather than as zero.
    """
    async with httpx.AsyncClient(base_url=proxy, timeout=5) as client:
        try:
            resp = await client.get("/slots")
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            logger.debug("slots unavailable at %s: %s", proxy, exc)
            return None

    try:
        raw = resp.json()
    except ValueError:
        return None
    if not isinstance(raw, list):
        return None

    slots = []
    for slot in raw:
        if not isinstance(slot, dict):
            continue
        n_ctx = slot.get("n_ctx")
        if not isinstance(n_ctx, int) or n_ctx <= 0:
            continue
        used = slot.get("n_prompt_tokens")
        slots.append({
            "id": slot.get("id"),
            "n_ctx": n_ctx,
            "used": used if isinstance(used, int) and used >= 0 else 0,
            "busy": bool(slot.get("is_processing")),
        })
    return slots


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


async def unload_model(model_id: str) -> bool:
    """Unload one model, leaving any others resident.

    Verified against llama-swap v247: POST /api/models/unload/{id} frees only
    the named model, while the bare /unload frees everything. Sharing one card
    between an LLM and ComfyUI makes that distinction worth having.
    """
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=60) as client:
        try:
            resp = await client.post(f"/api/models/unload/{model_id}")
            return resp.status_code == 200
        except httpx.HTTPError as exc:
            logger.warning("llama-swap unload of %s failed: %s", model_id, exc)
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


# How long after connecting llama-swap's scrollback keeps arriving. Measured at
# well under this; the margin is because the cost of guessing high is one
# missed sample and the cost of guessing low is a permanent phantom row.
REPLAY_WINDOW_S = 1.0


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
                    # llama-swap opens with a block of scrollback -- whatever is
                    # in its log buffer, however old. The log pane wants it and
                    # says so with timestamps; the request charts must not have
                    # it, because a replayed tick from a request that ended an
                    # hour ago is indistinguishable from a live one and draws a
                    # trace that is running, has one sample, and will never
                    # finish. That is exactly the row that sat at 100 tok and
                    # 0.0 t/s across page loads: not a stale trace, a fresh one
                    # built from an old line.
                    #
                    # Judged by a window rather than by a frame count: the
                    # scrollback arrives as several frames, not one, and which
                    # number the last of them lands on is not something to
                    # depend on. Anything inside the first second of a
                    # connection is treated as history; a real tick that lands
                    # in that second is lost, which costs one sample on a chart
                    # against a row that never goes away.
                    opened = time.monotonic()
                    async for sse in source.aiter_sse():
                        event = _parse_frame(sse.data)
                        if event is None:
                            continue
                        if time.monotonic() - opened > REPLAY_WINDOW_S:
                            throughput = extract_throughput(event)
                            if throughput:
                                yield {"type": "throughput", "data": throughput}
                            # Emitted beside the raw frame rather than instead
                            # of it: the log pane still wants every line, and
                            # these ticks are a read of the same line, not a
                            # replacement.
                            progress = extract_progress(event)
                            if progress:
                                yield {"type": "progress", "data": progress}
                        yield event
        except (httpx.HTTPError, asyncio.TimeoutError) as exc:
            logger.warning("llama-swap event stream lost (%s); retrying in %.0fs", exc, backoff)
        except Exception:
            logger.exception("unexpected error on llama-swap event stream")

        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 30.0)
