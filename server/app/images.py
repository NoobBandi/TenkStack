"""Re-encode images that llama.cpp cannot decode.

llama.cpp loads images with stb_image, which reads JPEG, PNG, GIF, BMP, PSD,
TGA, PNM, HDR and PIC -- and nothing else. A WebP, HEIC or AVIF arrives as bytes
it cannot parse, and all it can say back is

    {"error":{"code":400,"message":"Failed to load image or audio file"}}

which names neither the format nor which part of the request carried it. Apple
clients hit this routinely: Codex's `view_image` tool sends whatever file it was
pointed at, and an image saved out of a browser on macOS is usually WebP.

Converting here rather than teaching llama.cpp a new decoder keeps the fix on
the side that knows about clients, and next to the other Codex compatibility
work. A format llama.cpp already reads is passed through untouched -- the point
is to stop a request failing, not to re-encode every screenshot.
"""

from __future__ import annotations

import base64
import binascii
import io
import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

# Enough of a prefix to identify every container below. Sniffed rather than
# trusted from the mime label, because the label is written by the client and
# the bytes are what stb_image will actually meet.
_HEAD_B64 = 32          # 32 base64 chars decode to 24 bytes.
_MAX_BYTES = 32 << 20   # A frame larger than this is not a screenshot.


def _sniff(head: bytes) -> str | None:
    """Name the container from its magic bytes, or None if unrecognised."""
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    if head.startswith(b"BM"):
        return "bmp"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[4:8] == b"ftyp":
        # heic, heif, avif and friends all announce themselves this way.
        return head[8:12].decode("ascii", "replace").strip() or "iso-bmff"
    if head.lstrip()[:5] in (b"<?xml", b"<svg "):
        return "svg"
    return None


# stb_image's own list, cut to the formats a client actually sends.
PASSTHROUGH = {"png", "jpeg", "gif", "bmp"}


def _to_png(raw: bytes) -> bytes | None:
    """Re-encode to PNG, or None if this is not something Pillow can open.

    Imported lazily: a console that never proxies an image should not pay for
    Pillow at startup.
    """
    try:
        from PIL import Image
    except ImportError:
        logger.warning("cannot convert image: Pillow is not installed")
        return None
    try:
        with Image.open(io.BytesIO(raw)) as im:
            # An alpha channel survives; a palette or CMYK frame does not
            # convert to PNG on its own.
            im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
            out = io.BytesIO()
            im.save(out, "PNG", optimize=True)
            return out.getvalue()
    except Exception as exc:                       # noqa: BLE001 - any decode failure
        logger.warning("cannot convert image: %s", exc)
        return None


def _convert_b64(payload: str) -> tuple[str, str] | None:
    """Convert one base64 image, returning (new base64, original format).

    None means leave it alone: already readable, too big, not an image, or not
    convertible. Every one of those is a case where llama.cpp's own answer is
    no worse than a guess made here.
    """
    try:
        head = base64.b64decode(payload[:_HEAD_B64], validate=False)
    except (binascii.Error, ValueError):
        return None
    kind = _sniff(head)
    if kind is None or kind in PASSTHROUGH:
        return None
    # base64 carries 3 bytes in every 4 characters.
    if len(payload) // 4 * 3 > _MAX_BYTES:
        logger.warning("image too large to convert: %s, %d B64 chars", kind, len(payload))
        return None
    try:
        raw = base64.b64decode(payload, validate=False)
    except (binascii.Error, ValueError):
        return None
    png = _to_png(raw)
    if png is None:
        return None
    return base64.b64encode(png).decode("ascii"), kind


def _walk(node: Any, seen: list[str]) -> Any:
    """Rewrite every image in the tree, whatever shape the client wraps it in.

    Walking the whole body instead of the two known paths: OpenAI puts a data
    URI in `image_url`, the Responses API puts one in a tool call's output, and
    Anthropic sends bare base64 beside a `media_type`. All three reach the same
    decoder, and a fourth shape would too.
    """
    if isinstance(node, dict):
        source = node.get("source")
        if (isinstance(source, dict) and source.get("type") == "base64"
                and isinstance(source.get("data"), str)):
            converted = _convert_b64(source["data"])
            if converted:
                data, kind = converted
                seen.append(kind)
                node = dict(node, source=dict(source, data=data,
                                              media_type="image/png"))
                return node
        return {key: _walk(value, seen) for key, value in node.items()}
    if isinstance(node, list):
        return [_walk(item, seen) for item in node]
    if isinstance(node, str) and node.startswith("data:") and ";base64," in node:
        prefix, _, payload = node.partition(";base64,")
        converted = _convert_b64(payload)
        if converted:
            data, kind = converted
            seen.append(kind)
            head, _, _ = prefix.partition(":")
            return f"{head}:image/png;base64,{data}"
    return node


def transcode(body: bytes) -> bytes:
    """Return `body` with any image llama.cpp cannot read re-encoded as PNG.

    The body is returned unchanged unless something was actually converted, so
    a request carrying no image, or only readable ones, is not reserialised.
    """
    # Cheap gate: every shape above spells one of these somewhere in the bytes.
    if b"base64" not in body:
        return body
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return body
    seen: list[str] = []
    rewritten = _walk(payload, seen)
    if not seen:
        return body
    logger.info("converted %d image(s) to PNG for llama.cpp: %s",
                len(seen), ", ".join(sorted(set(seen))))
    return json.dumps(rewritten).encode()
