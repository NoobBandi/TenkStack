"""An image is described once, then referred to by that description.

WHY THIS EXISTS

A speculative drafter is a second model kept in step with the first, and an
image breaks that step. llama.cpp's mtmd decodes an image chunk straight into
the target context; with M-RoPE every row of one image reports the same
dim-0 position (`mtmd.cpp` sets `pos.t = pos_0` for all of them and puts the
geometry in dims 1 and 2), so the draft's one-dimensional cache is handed
thousands of rows claiming a single position. It cannot extend the sequence.
Upstream calls this ggml-org/llama.cpp#27408; it is open and unanswered, and
two sibling reports were closed as not planned.

The failure has two faces. With a long context the draft cache runs out of
cells and the request dies with "failed to process mtmd chunk". With a short
one it survives -- and quietly stops working: measured on this machine with a
1024x1024 image the drafter fell from 67% acceptance to 1%, and generation from
34.7 to 12.6 tokens a second. That is slower than not drafting at all, because
a rejected draft is paid for and returns nothing.

And it does not heal. Every later turn in that conversation carries the image,
so the whole session runs at a third speed -- one screenshot at the start of an
agent run costs every turn after it.

WHAT IS DONE ABOUT IT

Nothing that requires a different model, and nothing that gives up vision. The
image is sent to the model exactly once, in the turn that introduces it. After
the model has answered about it, later turns carry a placeholder in its place --
because the answer is still in the transcript, and that is what the model needs
to keep working from the picture it saw. The turn that looks at the picture is a
vision turn; every turn after it is text, and text is what the drafter is good
at.

A fuller description can be generated and cached as well, and is used when it
exists. It is an improvement rather than a requirement, and deliberately so: the
request that produces one carries the image, so it hits the same bug -- on this
machine it failed with `failed to find a memory slot` while an agent session
held the cache. Nothing that fixes a problem should depend on the problem.

Measured, same machine, same image:

    plain text, no image ever      34.7 tok/s   67% accepted
    image in the request           12.6 tok/s    1% accepted
    image replaced by description  27.5 tok/s   43% accepted

The second effect is context. A 1024x1024 image is about 1100 tokens and a full
page screenshot nearly 4000, carried in every subsequent request; the
description is a few hundred and does not grow.

WHAT IT COSTS

The model cannot look at the picture again. A description is not the picture,
and a question the description does not answer -- the exact corner radius, a
word in small type -- can no longer be answered. That is the trade, and it is
why the newest image is always left alone: whatever was just handed to the
model is still there to be examined.

This is also what the large providers do in effect. vLLM refuses speculative
decoding for multimodal models outright (`_raise_if_multimodal`), and making a
drafter vision-aware is still a research subject (ViSpec, MASSV, 2025-2026).
Keeping images out of the text turns is the part available today.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import sqlite3
import time

import httpx

from . import config, llamaswap, paths

logger = logging.getLogger(__name__)

DB_PATH = paths.DB_PATH

# What the model is asked for. Concrete rather than impressionistic: the reader
# of this text is the same model, later, trying to answer questions about a
# picture it can no longer see.
PROMPT = (
    "請詳細描述這張圖，讓沒看過它的人能據此回答關於它的問題。"
    "包含：主體與內容、版面配置與相對位置、顏色（可能的話給色碼）、"
    "圖中所有可辨識的文字、以及風格或用途。只描述看得到的東西。"
)

# Long enough to be useful, short enough to stay cheaper than the image it
# replaces. An image is ~1100 tokens at 1024x1024; this lands near 300.
MAX_TOKENS = 400

# Describing is a whole generation, so it must not hold up the turn that
# triggered it. The description is wanted from the *next* turn onwards.
_pending: set[str] = set()


def init() -> None:
    with sqlite3.connect(DB_PATH) as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS vision_descriptions (
                digest      TEXT PRIMARY KEY,
                model       TEXT NOT NULL,
                description TEXT NOT NULL,
                bytes       INTEGER NOT NULL,
                created_at  REAL NOT NULL
            )
        """)


def digest_of(data_url: str) -> str:
    """A stable name for one image.

    Over the payload rather than the whole URL so the same picture sent with a
    different mime prefix is still the same picture.
    """
    payload = data_url.split(",", 1)[-1]
    return hashlib.sha256(payload.encode("utf-8", "ignore")).hexdigest()


def lookup(digest: str) -> str | None:
    with sqlite3.connect(DB_PATH) as db:
        row = db.execute(
            "SELECT description FROM vision_descriptions WHERE digest = ?",
            (digest,),
        ).fetchone()
    return row[0] if row else None


def store(digest: str, model: str, description: str, size: int) -> None:
    with sqlite3.connect(DB_PATH) as db:
        db.execute(
            "INSERT OR REPLACE INTO vision_descriptions"
            " (digest, model, description, bytes, created_at) VALUES (?, ?, ?, ?, ?)",
            (digest, model, description, size, time.time()),
        )


# Which models this is worth doing for, by the drafter they run.
#
# What an image breaks is a drafter that keeps its own one-dimensional recurrent
# cache and has to be fed every position in order -- DFlash and its relatives.
# MTP does not have one: its head predicts from the target's hidden state and
# uses an ordinary attention cache, so a picture costs it nothing. That holds
# whether the head ships inside the target (Qwen 3.8, a `nextn` layer) or as a
# separate file (Gemma 4, `--model-draft`); measured on this machine, Gemma with
# an image in the transcript drafted at 30-78% accepted, the same as plain text.
#
# So the question is the *type* of drafter, not whether a second file is loaded.
# Asking "is there a --spec-draft-model" was the wrong proxy: it said no for
# Gemma's `--model-draft` spelling and would have said yes for an MTP head shipped
# as a file, and rewriting where it is not needed is not neutral -- it throws
# away the prompt prefix and what the model was told, and measured 27.9 -> 21.7
# tok/s on Qwen MTP and 26.0 -> 20.2 on Gemma.
#
# Keyed on when the config was last written, because changing a model's drafter
# is exactly the edit that makes a cached answer here wrong.
_HAS_DRAFT_MODEL: dict[tuple[str, float], bool] = {}


# The `--spec-type` values that carry a recurrent draft cache. `draft-mtp` and
# the `ngram-*` family are deliberately absent: neither keeps per-position draft
# state that an image can leave holes in.
_FRAGILE_DRAFTERS = ("draft-dflash", "draft-eagle3", "draft-dspark", "draft-simple")


def _has_fragile_drafter(cmd: str) -> bool:
    """Whether this launch line names a drafter that images break."""
    tokens = cmd.split()
    for i, tok in enumerate(tokens):
        if tok == "--spec-type" and i + 1 < len(tokens):
            kinds = tokens[i + 1].split(",")
        elif tok.startswith("--spec-type="):
            kinds = tok.split("=", 1)[1].split(",")
        else:
            continue
        if any(k in _FRAGILE_DRAFTERS for k in kinds):
            return True
    return False


def _uses_draft_model(model_id: str) -> bool:
    try:
        stamp = paths.LLAMA_SWAP_CONFIG.stat().st_mtime
    except OSError:
        stamp = 0.0
    key = (model_id, stamp)
    if key in _HAS_DRAFT_MODEL:
        return _HAS_DRAFT_MODEL[key]
    try:
        spec = config.read_model_spec(model_id)
        cmd = " ".join(str(spec.get("extra") or "").splitlines())
        found = _has_fragile_drafter(cmd)
    except Exception:
        # Unknown is treated as "not worth touching": leaving a request alone is
        # always safe, and rewriting one that did not need it is not.
        found = False
    _HAS_DRAFT_MODEL.clear()      # one config, one generation of answers
    _HAS_DRAFT_MODEL[key] = found
    return found


def _images_in(message: dict) -> list[tuple[int, str]]:
    """The (index, data URL) of every image part of one message."""
    content = message.get("content")
    if not isinstance(content, list):
        return []
    found = []
    for i, part in enumerate(content):
        if not isinstance(part, dict):
            continue
        url = ((part.get("image_url") or {}).get("url")
               if part.get("type") == "image_url" else None)
        if isinstance(url, str) and url.startswith("data:"):
            found.append((i, url))
    return found


async def describe(model: str, data_url: str) -> str | None:
    """Ask the model to describe one image, once.

    Sent through llama-swap the same way any other request is, so it lands on
    the model that is already loaded and shares its prompt cache.
    """
    body = {
        "model": model,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": PROMPT},
            {"type": "image_url", "image_url": {"url": data_url}},
        ]}],
        "max_tokens": MAX_TOKENS,
        "temperature": 0,
    }
    try:
        async with httpx.AsyncClient(base_url=llamaswap.BASE_URL, timeout=600) as client:
            resp = await client.post("/v1/chat/completions", json=body)
            resp.raise_for_status()
            message = resp.json()["choices"][0]["message"]
    except (httpx.HTTPError, KeyError, IndexError, ValueError):
        logger.exception("could not describe an image for %s", model)
        return None
    # A thinking model may put everything in `reasoning_content` when the answer
    # runs past the token budget; either is better than nothing.
    text = (message.get("content") or message.get("reasoning_content") or "").strip()
    return text or None


def _remember(model: str, data_url: str) -> None:
    """Describe this image in the background, if it is new."""
    key = digest_of(data_url)
    if key in _pending or lookup(key) is not None:
        return
    # Only from inside the request loop. `rewrite` is called from the proxy, so
    # there is one -- but a caller without a loop must get its body rewritten
    # rather than an exception, because this is a cache and cache work is never
    # worth failing a request over.
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return

    _pending.add(key)

    async def work() -> None:
        try:
            text = await describe(model, data_url)
            if text:
                store(key, model, text, len(data_url))
                logger.info("described image %s for %s (%d chars)", key[:12], model, len(text))
        finally:
            _pending.discard(key)

    loop.create_task(work())


def rewrite(body: dict) -> tuple[dict, int]:
    """Replace already-described images with their descriptions.

    The newest image is never replaced. Whatever was just handed to the model
    has to still be there for it to look at -- this is a cache for what the
    conversation has moved past, not a way to stop the model seeing.

    Returns the body and how many images were replaced; the body is returned
    unchanged, not copied, when nothing was.
    """
    messages = body.get("messages")
    if not isinstance(messages, list) or len(messages) < 2:
        return body, 0
    model = str(body.get("model") or "")
    if not _uses_draft_model(model):
        return body, 0

    # The boundary is the turn being answered, not the last image.
    #
    # An image in the final user message is what the model was just handed and
    # has not spoken about yet; it stays. An image in any earlier message has
    # already been answered -- the reply is right there in the transcript -- so
    # the picture has done its job and the description can stand in for it.
    #
    # Drawing the line at "the last message that happens to hold an image"
    # instead would never replace anything in the common case: one screenshot,
    # then twenty text turns about it. That is exactly the case worth fixing.
    boundary = len(messages)
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        if isinstance(message, dict) and message.get("role") == "user":
            boundary = index
            break

    # Whatever is in that turn is what a description will be made from, so it is
    # ready for the turn after this one.
    if boundary < len(messages):
        for _, url in _images_in(messages[boundary]):
            _remember(model, url)

    replaced = 0
    out = list(messages)
    for index in range(boundary):
        message = out[index]
        images = _images_in(message)
        if not images:
            continue
        # The model's own reply is the description.
        #
        # It is already in the transcript, one message down: whatever it said
        # about the picture when it could still see it. Measured, that reply
        # alone is enough -- an image swapped for a placeholder, with the reply
        # left where it was, took acceptance from 1% back to 43%. Which is why
        # a separate description is an improvement here and never a requirement:
        # asking for one means another request carrying the image, and that is
        # the request that fails when the draft cache is already full of the
        # cells the last image churned.
        answered = any(
            isinstance(later, dict) and later.get("role") == "assistant"
            for later in messages[index + 1:boundary + 1]
        )
        if not answered:
            continue      # the model never spoke about it; it still needs to see it

        content = list(message.get("content") or [])
        for part_index, url in images:
            text = lookup(digest_of(url))
            content[part_index] = {
                "type": "text",
                "text": (f"［這張圖模型稍早看過，以下是它的描述］\n{text}" if text
                         else "［圖片已省略——模型稍早看過它，它的說明在下一則訊息］"),
            }
            replaced += 1
        out[index] = {**message, "content": content}

    if not replaced:
        return body, 0
    return {**body, "messages": out}, replaced
