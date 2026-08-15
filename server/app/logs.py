"""One log stream for every part of the platform.

Read from the systemd journal rather than collected by hand. Three of the four
services are user units, so the journal already holds what the console was
previously guessing at: a real severity per line, the unit that emitted it, a
timestamp, and -- because /var/log/journal exists on this host -- history from
before anyone opened the page. The old viewer only saw llama-swap, only from
the moment the browser connected, and inferred "error" by matching the word
against the text.

ComfyUI runs in Docker with the json-file driver and is followed through
`docker logs` instead. Switching the container to the journald driver would put
all four in one place, but that means recreating the container, and reading its
logs directly costs one more subprocess and no downtime.

One reader per source for the whole process, feeding a shared buffer that every
connected client is served from -- the same shape as the GPU history poller, and
for the same reason: a browser should not spawn a journalctl.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import time
from collections import deque
from datetime import datetime

logger = logging.getLogger(__name__)

CAPACITY = 4000
# Enough to fill a screen on arrival without making the first payload heavy.
BACKFILL = 400

UNITS = {
    "llama-swap.service": "模型",
    "caddy.service": "代理",
    "ai-console.service": "主控台",
    # The user manager's own scope, which is where "Started", "Stopped" and
    # failed-reload messages about the units above are recorded. Worth keeping:
    # it is the only place a service that died on startup says so.
    "init.scope": "系統",
}
COMFY_CONTAINER = "comfyui-xpu"
COMFY_LABEL = "圖像"

# xpu-smi writes a dozen lines of MEI permission errors straight to syslog on
# every invocation, and the GPU poller runs one twice a second. Left in, it is
# half a million lines a day and nothing else in the console's journal would be
# visible. The failure is real but constant and harmless: it cannot read the
# management engine, which none of the telemetry here needs.
NOISE_IDENTIFIERS = {"xpu-smi"}

# Terminal colour codes, which ComfyUI emits freely and which would otherwise
# show up as literal escape sequences in the browser.
_ANSI = re.compile(r"\x1b\[[0-9;]*m")

_lines: deque[dict] = deque(maxlen=CAPACITY)
_subscribers: set[asyncio.Queue] = set()
_tasks: list[asyncio.Task] = []
# The readers hold long-lived children. Cancelling the task that awaits them is
# not enough: `journalctl --follow` and `docker logs --follow` ignore the
# cancellation entirely and keep the service alive until systemd's stop timeout
# expires and SIGKILLs the lot -- ninety seconds of 502s on every restart.
_children: set[asyncio.subprocess.Process] = set()


def _level(priority: int | None) -> str:
    """syslog severity -> the three levels the UI colours.

    0-3 are emerg/alert/crit/err, 4 is warning, and everything below that is
    informational. Collapsing them keeps the filter to three buttons; the
    original number is not something anyone reads on a home console.
    """
    if priority is None:
        return "info"
    if priority <= 3:
        return "error"
    if priority == 4:
        return "warn"
    return "info"


# Caddy writes structured JSON to stderr, and journald stamps everything that
# arrives that way as PRIORITY=6. Its own `level` field is the truth: without
# reading it, every Caddy error was filed as information and the severity filter
# could never surface one.
_CADDY_LEVEL = {
    "debug": "info", "info": "info", "warn": "warn",
    "error": "error", "panic": "error", "fatal": "error",
}

# llama-swap prefixes its lines instead of encoding them.
_BRACKET = re.compile(r"^\[(DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\]\s*")

# The console's own lines arrive twice-labelled: uvicorn writes "INFO:" and
# Python's logging writes a full "date time LEVEL logger:" preamble. The row
# already has a time column and a level badge, so repeating both inside the
# message wastes the width and reads as a mistake.
_PY_PREAMBLE = re.compile(
    r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[,.]\d+\s+"
    r"(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\s+",
)
_BARE_LEVEL = re.compile(r"^(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\s*:\s+")

_WORD_TO_LEVEL = {
    "debug": "info", "info": "info", "warning": "warn", "warn": "warn",
    "error": "error", "critical": "error", "fatal": "error",
}


def _strip_preamble(text: str) -> tuple[str, str | None]:
    """Remove a leading timestamp and level, returning what they said.

    Only the head of the line is touched: an "ERROR" appearing later is part of
    the message and stays there.
    """
    match = _PY_PREAMBLE.match(text)
    if match:
        return text[match.end():], _WORD_TO_LEVEL.get(match.group(1).lower())
    match = _BARE_LEVEL.match(text)
    if match:
        return text[match.end():], _WORD_TO_LEVEL.get(match.group(1).lower())
    return text, None

# Fields that become the row itself rather than part of its detail.
_CONSUMED = {"level", "ts", "msg", "time", "message"}

# An HTTP status is often the only honest severity a request line has: both
# llama-swap and Caddy record a failed request at INFO and put the failure in
# the number. Matched two ways -- a JSON field, and the common-log shape where
# the code follows the quoted request.
_STATUS_JSON = re.compile(r'"status(?:Code)?"\s*:\s*"?(\d{3})"?')
_STATUS_CLF = re.compile(r'"[A-Z]+ [^"]*HTTP/[\d.]+"\s+(\d{3})\b')

# Phrases that say a failure did *not* happen. Without this, "errors: 0" and
# "failed=false" are read as errors by any keyword match -- which is exactly
# what the old ComfyUI classifier did.
_NOT_AN_ERROR = re.compile(
    r"\b(?:error|err|errors|failed|failure|failures)\s*[:=]\s*"
    r"(?:none|null|nil|false|0|no|-|\"\"|'')(?=[\s,;.)\]]|$)",
    re.I,
)


def _status_level(text: str) -> str | None:
    """Severity implied by an HTTP status code, if the line carries one.

    2xx is deliberately not promoted to a level of its own. Nearly every line
    llama-swap writes is a successful request, and colouring the ordinary case
    would leave a wall of green with the unusual lines hidden inside it.
    """
    match = _STATUS_JSON.search(text) or _STATUS_CLF.search(text)
    if not match:
        return None
    code = int(match.group(1))
    if code >= 500:
        return "error"
    if code >= 400:
        return "warn"
    return None


def _keyword_level(text: str) -> str:
    """Last resort, for sources that declare nothing -- ComfyUI's driver has no
    severity field at all."""
    scope = _NOT_AN_ERROR.sub("", text).lower()
    if "traceback" in scope or re.search(r"\berror\b|\bexception\b|\bfailed\b", scope):
        return "error"
    if re.search(r"\bwarn(?:ing)?\b", scope):
        return "warn"
    return "info"


def _flatten(value: object, prefix: str = "", depth: int = 0) -> list[tuple[str, str]]:
    """Nested structure as dotted key/value pairs, for the expanded view.

    Depth-capped: Caddy's request objects carry a full header map, and rendering
    it whole turns one line into forty.
    """
    out: list[tuple[str, str]] = []
    if isinstance(value, dict) and depth < 3:
        for key, inner in value.items():
            out += _flatten(inner, f"{prefix}.{key}" if prefix else str(key), depth + 1)
    elif isinstance(value, list) and depth < 3:
        if all(not isinstance(v, (dict, list)) for v in value):
            out.append((prefix, ", ".join(str(v) for v in value)))
        else:
            for i, inner in enumerate(value):
                out += _flatten(inner, f"{prefix}[{i}]", depth + 1)
    else:
        out.append((prefix, str(value)))
    return out


def _structure(text: str, level: str) -> tuple[str, str, list[tuple[str, str]] | None]:
    """Split a line into what to show, how bad it is, and what to hide behind it.

    Returns (summary, level, fields). `fields` is None for a line that carries
    no structure, which is what tells the UI not to offer an expander.
    """
    stripped = text.lstrip()

    if stripped.startswith("{"):
        try:
            data = json.loads(stripped)
        except (json.JSONDecodeError, ValueError):
            return text, level, None
        if not isinstance(data, dict):
            return text, level, None

        own = str(data.get("level", "")).lower()
        if own in _CADDY_LEVEL:
            level = _CADDY_LEVEL[own]
        # A 5xx outranks the logger's own "info": the request failed whatever
        # the line calls itself.
        by_status = _status_level(stripped)
        if by_status and (by_status == "error" or level == "info"):
            level = by_status

        summary = str(data.get("msg") or data.get("message") or "")
        logger_name = data.get("logger")
        if logger_name and summary:
            summary = f"{logger_name}: {summary}"

        fields: list[tuple[str, str]] = []
        for key, value in data.items():
            if key in _CONSUMED or key == "logger":
                continue
            fields += _flatten(value, key)
        return summary or stripped, level, fields or None

    without, declared = _strip_preamble(stripped)
    if declared:
        level = declared
        by_status = _status_level(without)
        if by_status and (by_status == "error" or level == "info"):
            level = by_status
        return without, level, None

    match = _BRACKET.match(stripped)
    if match:
        word = match.group(1).lower()
        level = "error" if word in ("error", "fatal") else \
                "warn" if word.startswith("warn") else "info"
        rest = stripped[match.end():]
        by_status = _status_level(rest)
        if by_status and (by_status == "error" or level == "info"):
            level = by_status
        return rest, level, None

    by_status = _status_level(text)
    return text, by_status or level, None


def _emit(line: dict) -> None:
    _lines.append(line)
    for queue in list(_subscribers):
        with contextlib.suppress(asyncio.QueueFull):
            queue.put_nowait(line)


def history(limit: int = BACKFILL) -> list[dict]:
    return list(_lines)[-limit:]


def subscribe() -> asyncio.Queue:
    queue: asyncio.Queue = asyncio.Queue(maxsize=500)
    _subscribers.add(queue)
    return queue


def unsubscribe(queue: asyncio.Queue) -> None:
    _subscribers.discard(queue)


async def _read_journal() -> None:
    args = [
        "journalctl", "--user", "-o", "json", "--follow",
        "-n", str(BACKFILL), "--no-pager",
    ]
    for unit in UNITS:
        args += ["-u", unit]

    while True:
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
        except OSError:
            # No journalctl: the rest of the console still works, so this is a
            # missing feature rather than a failure to report every few seconds.
            return

        _children.add(proc)
        assert proc.stdout is not None
        while True:
            raw = await proc.stdout.readline()
            if not raw:
                break
            try:
                entry = json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue

            if entry.get("SYSLOG_IDENTIFIER") in NOISE_IDENTIFIERS:
                continue

            message = entry.get("MESSAGE")
            if isinstance(message, list):
                # Binary payloads arrive as an array of byte values.
                message = bytes(message).decode("utf-8", "replace")
            if not message:
                continue

            unit = entry.get("_SYSTEMD_USER_UNIT") or entry.get("UNIT") or ""
            stamp = entry.get("__REALTIME_TIMESTAMP")
            try:
                seconds = int(stamp) / 1_000_000 if stamp else time.time()
            except (TypeError, ValueError):
                seconds = time.time()

            try:
                priority = int(entry.get("PRIORITY", 6))
            except (TypeError, ValueError):
                priority = 6

            clean = _ANSI.sub("", str(message)).rstrip()
            summary, level, fields = _structure(clean, _level(priority))
            _emit({
                "t": seconds,
                "unit": unit,
                "label": UNITS.get(unit, unit or "系統"),
                "level": level,
                "text": summary,
                "fields": fields,
            })

        _children.discard(proc)
        # journalctl exited -- a rotation or a killed process. Wait before
        # respawning so a permanent failure does not become a spin.
        await asyncio.sleep(5)


async def _read_docker() -> None:
    while True:
        try:
            proc = await asyncio.create_subprocess_exec(
                "docker", "logs", "--follow", "--timestamps", "--tail", "200",
                COMFY_CONTAINER,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
        except OSError:
            return

        _children.add(proc)
        assert proc.stdout is not None
        while True:
            raw = await proc.stdout.readline()
            if not raw:
                break
            text = raw.decode("utf-8", "replace").rstrip()
            if not text:
                continue

            # `--timestamps` prefixes RFC3339; split it back off so the line
            # sorts with the journal's rather than carrying its own clock.
            seconds = time.time()
            stamp, _, rest = text.partition(" ")
            if stamp.endswith("Z") and "T" in stamp:
                with contextlib.suppress(ValueError):
                    seconds = datetime.fromisoformat(
                        stamp.replace("Z", "+00:00")
                    ).timestamp()
                    text = rest

            clean = _ANSI.sub("", text)
            # Docker's json-file driver carries no severity of its own, so the
            # words are the only signal unless the line is itself structured.
            summary, level, fields = _structure(clean, _keyword_level(clean))

            _emit({
                "t": seconds,
                "unit": COMFY_CONTAINER,
                "label": COMFY_LABEL,
                "level": level,
                "text": summary,
                "fields": fields,
            })

        _children.discard(proc)
        await asyncio.sleep(5)


def start() -> None:
    if _tasks:
        return
    _tasks.append(asyncio.create_task(_read_journal()))
    _tasks.append(asyncio.create_task(_read_docker()))
    logger.info("log readers started (journal + docker)")


async def stop() -> None:
    """Stop the readers and the processes they are reading from."""
    for task in _tasks:
        task.cancel()
    for child in list(_children):
        with contextlib.suppress(ProcessLookupError):
            child.terminate()
    await asyncio.gather(*_tasks, return_exceptions=True)
    # Give them a moment to go, then insist. A follower that ignores SIGTERM
    # would otherwise hold the whole service open.
    for child in list(_children):
        with contextlib.suppress(asyncio.TimeoutError, ProcessLookupError):
            await asyncio.wait_for(child.wait(), 3)
        if child.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                child.kill()
    _children.clear()
    _tasks.clear()
