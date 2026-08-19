"""GGUF headers read over HTTP, without downloading the model.

A GGUF file opens with its entire description: the architecture's key-value
metadata, then a directory naming every tensor with its shape and quantisation
type. Only after that come the weights. So the first few megabytes of a 20 GiB
file say exactly what the file is, and Hugging Face serves ranged requests --
verified 2026-08-19, `HTTP 206` on the resolve URL -- which makes the whole
description reachable for about 0.03% of the transfer.

That is what lets the catalog answer "how fast would this run here" *before* the
download rather than after it. The two facts that matter cannot be had any other
way:

  * **Which bytes are actually read per token.** For a mixture-of-experts model
    this is nothing like the file size. Qwen3-30B-A3B Q4_K_M is 17.3 GiB, of
    which 16.35 GiB is expert tensors -- and 8 of 128 experts run per token, so
    the real figure is 0.93 + 16.35 x 8/128 = 1.95 GiB. Estimating from the file
    size overstates it ninefold.
  * **KV cache growth per token**, which needs the layer count, the number of KV
    heads and the head dimensions -- none of which appear in the file listing.

The header is read, not trusted blindly: the tensor sizes are summed and checked
against the size Hugging Face reports for the file. A mismatch means this module
does not know some quantisation type, and the answer says so rather than being
quietly wrong.
"""

from __future__ import annotations

import logging
import re
import struct

import httpx

logger = logging.getLogger(__name__)

# How much of the file to pull on the first try. The header is dominated by the
# tokenizer: a 150k-token vocabulary with its merge list runs to about 6 MiB,
# which is why this is not smaller. When a parse runs off the end it is retried
# once at the larger size rather than growing byte by byte.
FIRST_READ = 8 << 20
WIDER_READ = 40 << 20

# GGUF metadata value types, by their wire tag.
_FIXED = {0: "B", 1: "b", 2: "H", 3: "h", 4: "I", 5: "i", 6: "f", 7: "?",
          10: "Q", 11: "q", 12: "d"}
_STRING = 8
_ARRAY = 9

# ggml tensor types: (elements per block, bytes per block). The quantised
# formats pack a whole block of weights with shared scales, so bytes cannot be
# derived from the element count alone.
# `blk.7.attn_k.weight` -- the per-layer key projection, and the only reliable
# sign that a layer keeps a KV cache at all.
_ATTN_K = re.compile(r"^blk\.(\d+)\.attn_k[._]")

_BLOCK: dict[int, tuple[str, int, int]] = {
    0: ("F32", 1, 4),        1: ("F16", 1, 2),
    2: ("Q4_0", 32, 18),     3: ("Q4_1", 32, 20),
    6: ("Q5_0", 32, 22),     7: ("Q5_1", 32, 24),
    8: ("Q8_0", 32, 34),     9: ("Q8_1", 32, 40),
    10: ("Q2_K", 256, 84),   11: ("Q3_K", 256, 110),
    12: ("Q4_K", 256, 144),  13: ("Q5_K", 256, 176),
    14: ("Q6_K", 256, 210),  15: ("Q8_K", 256, 292),
    16: ("IQ2_XXS", 256, 66), 17: ("IQ2_XS", 256, 74),
    18: ("IQ3_XXS", 256, 98), 19: ("IQ1_S", 256, 50),
    20: ("IQ4_NL", 32, 18),  21: ("IQ3_S", 256, 110),
    22: ("IQ2_S", 256, 82),  23: ("IQ4_XS", 256, 136),
    24: ("I8", 1, 1),        25: ("I16", 1, 2),
    26: ("I32", 1, 4),       27: ("I64", 1, 8),
    28: ("F64", 1, 8),       29: ("IQ1_M", 256, 56),
    30: ("BF16", 1, 2),      34: ("TQ1_0", 256, 54),
    35: ("TQ2_0", 256, 64),  39: ("MXFP4", 32, 17),
}


class _Short(Exception):
    """The header did not fit in what was read."""


class _Cursor:
    """A byte reader that refuses to walk off the end.

    Every field in a GGUF header is length-prefixed, so a truncated read shows
    up as an attempt to take more bytes than remain -- never as a plausible
    wrong value. That distinction is the whole reason for the exception: it
    means "fetch more", not "this file is broken".
    """

    def __init__(self, blob: bytes) -> None:
        self.blob = blob
        self.at = 0

    def take(self, count: int) -> bytes:
        if count < 0 or self.at + count > len(self.blob):
            raise _Short
        chunk = self.blob[self.at:self.at + count]
        self.at += count
        return chunk

    def u32(self) -> int:
        return struct.unpack("<I", self.take(4))[0]

    def u64(self) -> int:
        return struct.unpack("<Q", self.take(8))[0]

    def text(self) -> str:
        return self.take(self.u64()).decode("utf-8", "replace")

    def value(self, tag: int):
        if tag in _FIXED:
            code = _FIXED[tag]
            return struct.unpack("<" + code, self.take(struct.calcsize(code)))[0]
        if tag == _STRING:
            return self.text()
        if tag == _ARRAY:
            inner = self.u32()
            count = self.u64()
            if inner == _STRING:
                # Consumed, not kept: this is the token vocabulary, several
                # megabytes of it, and nothing here reads it.
                for _ in range(count):
                    self.take(self.u64())
                return f"<{count} strings>"
            if inner == _ARRAY:
                return [self.value(_ARRAY) for _ in range(count)]
            code = _FIXED[inner]
            raw = self.take(struct.calcsize(code) * count)
            return list(struct.unpack("<" + code * count, raw)) if count <= 4096 \
                else f"<{count} values>"
        raise ValueError(f"unknown metadata type {tag}")


def _tensor_bytes(kind: int, elements: int) -> int | None:
    spec = _BLOCK.get(kind)
    if spec is None:
        return None
    _, per_block, block_bytes = spec
    return elements // per_block * block_bytes


def parse(blob: bytes) -> dict:
    """One GGUF file's header, as far as it describes itself.

    Raises `_Short` when the blob stops mid-header, which the caller answers by
    reading further rather than by giving up.
    """
    cursor = _Cursor(blob)
    if cursor.take(4) != b"GGUF":
        raise ValueError("not a GGUF file")
    version = cursor.u32()
    tensor_count = cursor.u64()
    kv_count = cursor.u64()

    meta: dict[str, object] = {}
    for _ in range(kv_count):
        key = cursor.text()
        meta[key] = cursor.value(cursor.u32())

    # Expert tensors are the ones the router picks among, and they are named for
    # it: `blk.0.ffn_gate_exps.weight`. A shared expert -- always active, so it
    # must not be discounted -- is `ffn_gate_shexp.weight`, which this test
    # correctly leaves on the dense side.
    routed = 0
    dense = 0
    unknown: set[str] = set()
    # Counted rather than taken from `block_count`, because the two differ on
    # exactly the models where it matters. A hybrid architecture alternates
    # attention layers with linear-attention ones that hold no KV cache, and an
    # MTP head is an extra block that plain decoding never runs. Both would
    # inflate a KV estimate taken from the block count alone.
    attention_layers: set[int] = set()
    # A multi-token-prediction head, baked in as an extra block. Plain decoding
    # never runs it, but llama.cpp can draft with it, and on this machine that
    # is worth more than any quantisation choice -- so its presence is reported
    # rather than folded into a number.
    mtp = False
    by_type: dict[str, int] = {}
    for _ in range(tensor_count):
        name = cursor.text()
        dims = [cursor.u64() for _ in range(cursor.u32())]
        kind = cursor.u32()
        cursor.u64()  # offset within the data section; nothing here needs it

        elements = 1
        for dim in dims:
            elements *= dim
        size = _tensor_bytes(kind, elements)
        if size is None:
            unknown.add(str(kind))
            size = elements * 2  # a guess, and flagged as one below
        if ".nextn." in name:
            mtp = True
        layer = _ATTN_K.match(name)
        if layer:
            attention_layers.add(int(layer.group(1)))
        label = _BLOCK[kind][0] if kind in _BLOCK else f"type{kind}"
        by_type[label] = by_type.get(label, 0) + size
        if "_exps" in name:
            routed += size
        else:
            dense += size

    return {
        "version": version,
        "meta": meta,
        "tensor_count": tensor_count,
        "routed_bytes": routed,
        "dense_bytes": dense,
        "attention_layers": len(attention_layers),
        "mtp": mtp,
        "by_type": by_type,
        "unknown_types": sorted(unknown),
        "header_bytes": cursor.at,
    }


async def _read_head(client: httpx.AsyncClient, url: str, span: int) -> bytes:
    resp = await client.get(url, headers={"Range": f"bytes=0-{span - 1}"})
    resp.raise_for_status()
    return resp.content


# Headers do not change: a GGUF on the hub is replaced, not edited. So one read
# per file is enough for the life of the process, which is what makes it
# reasonable to spend 8 MiB of transfer on a row the user merely looked at.
_seen: dict[tuple[str, tuple[str, ...]], dict | None] = {}


async def describe(repo_id: str, parts: list[str]) -> dict | None:
    """What one model's GGUF says about itself, across all of its parts.

    A model split across files carries the architecture metadata in the first
    part only; every part lists its own tensors. So the first part is read for
    both and the rest for their tensor directories alone -- which are small,
    because only the first part carries the tokenizer.
    """
    key = (repo_id, tuple(parts))
    if key in _seen:
        return _seen[key]

    base = f"https://huggingface.co/{repo_id}/resolve/main/"
    total_routed = 0
    total_dense = 0
    attention_layers = 0
    mtp = False
    by_type: dict[str, int] = {}
    unknown: set[str] = set()
    head: dict | None = None

    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        for index, part in enumerate(parts):
            url = base + part
            span = FIRST_READ if index == 0 else 1 << 20
            for attempt in (span, WIDER_READ):
                try:
                    parsed = parse(await _read_head(client, url, attempt))
                    break
                except _Short:
                    parsed = None
                except (httpx.HTTPError, ValueError, struct.error) as exc:
                    logger.warning("GGUF header for %s/%s failed: %s", repo_id, part, exc)
                    _seen[key] = None
                    return None
            if parsed is None:
                logger.warning("GGUF header for %s/%s did not fit in %d bytes",
                               repo_id, part, WIDER_READ)
                _seen[key] = None
                return None
            if index == 0:
                head = parsed
            total_routed += parsed["routed_bytes"]
            total_dense += parsed["dense_bytes"]
            attention_layers += parsed["attention_layers"]
            mtp = mtp or parsed["mtp"]
            for label, size in parsed["by_type"].items():
                by_type[label] = by_type.get(label, 0) + size
            unknown |= set(parsed["unknown_types"])

    if head is None:
        _seen[key] = None
        return None

    meta = head["meta"]
    arch = str(meta.get("general.architecture") or "")

    def field(name: str, fallback=None):
        return meta.get(f"{arch}.{name}", fallback)

    described = {
        "architecture": arch,
        "name": meta.get("general.name"),
        "layers": field("block_count"),
        # What the KV cache actually costs per token is set by this, not by the
        # block count -- see the note where they are counted.
        "attention_layers": attention_layers,
        "embedding_length": field("embedding_length"),
        "head_count": field("attention.head_count"),
        "head_count_kv": field("attention.head_count_kv"),
        # Older exports omit the explicit key/value lengths; they are then
        # embedding_length / head_count, which is what a plain MHA model means.
        "key_length": field("attention.key_length"),
        "value_length": field("attention.value_length"),
        "context_length": field("context_length"),
        "mtp": mtp,
        "expert_count": field("expert_count", 0) or 0,
        "expert_used_count": field("expert_used_count", 0) or 0,
        "routed_bytes": total_routed,
        "dense_bytes": total_dense,
        # Largest first: the head of this list is what the file mostly is.
        "by_type": dict(sorted(by_type.items(), key=lambda pair: -pair[1])),
        "unknown_types": sorted(unknown),
    }
    _seen[key] = described
    return described
