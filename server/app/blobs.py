"""Images on disk, addressed by their contents.

They used to live in the messages table as `data:image/png;base64,…`, which is
the shape a browser hands over and the wrong shape to keep. Base64 is a third
larger than the bytes it carries, every read of a conversation dragged the
whole string through JSON, and on this machine 72% of the database was one
column.

Addressed by SHA-256 rather than by a name, which buys two things. The same
image stored twice costs once -- an agent re-running the same plot, a
conversation branched and re-saved, a picture pasted into two chats. And
because the name *is* the content, a stored blob can never change, so it is
served with a year's cache and the browser never asks twice.

Two obligations come with taking them out of the database, and both are real:

  * **Deleting a conversation no longer deletes its images.** It cannot: the
    blob may be referenced by another message. Reclaiming space is a sweep over
    what is still referenced, not a cascade -- see `sweep`.
  * **The file must be written before the row that points at it.** A database
    transaction happens or does not; a file plus a row can half-happen. In this
    order the failure leaves an unreferenced file, which the sweep collects; in
    the other order it leaves a broken image.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import re
from pathlib import Path

from . import paths

logger = logging.getLogger(__name__)

DIR = paths.STATE_DIR / "blobs"

# `blob:` and 64 hex characters. Deliberately not a path: what is stored is a
# name, and the directory layout stays this module's business.
REF = re.compile(r"^blob:([0-9a-f]{64})$")

_DATA_URI = re.compile(r"^data:([\w.+-]+/[\w.+-]+);base64,(.+)$", re.S)

# What a media type is called on disk. Anything else keeps `.bin`: the suffix
# is a convenience for whoever opens the directory, not something the console
# reads back -- the type is served from the reference table below.
_SUFFIX = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
    "image/gif": ".gif", "image/svg+xml": ".svg", "image/avif": ".avif",
}
_MEDIA = {suffix: media for media, suffix in _SUFFIX.items()}


def _path(digest: str, suffix: str = "") -> Path:
    # Two hex characters of fan-out: a flat directory of a hundred thousand
    # files is slow to list and unpleasant to look at, and this is one `ls`
    # away from being readable at any size.
    return DIR / digest[:2] / f"{digest}{suffix}"


def _existing(digest: str) -> Path | None:
    folder = DIR / digest[:2]
    if not folder.is_dir():
        return None
    for path in folder.glob(f"{digest}.*"):
        return path
    return None


def store(data_uri: str) -> str | None:
    """Write one data URI to disk and return its reference, or None.

    None for anything that is not a base64 data URI -- an http URL, an already
    stored reference, a string that is neither -- because those are already
    something this module should leave alone rather than guess about.
    """
    match = _DATA_URI.match(data_uri.strip())
    if not match:
        return None
    media, encoded = match.group(1), match.group(2)
    try:
        raw = base64.b64decode(encoded, validate=False)
    except Exception:
        logger.warning("could not decode a data URI of %d characters", len(encoded))
        return None

    digest = hashlib.sha256(raw).hexdigest()
    if _existing(digest) is None:
        path = _path(digest, _SUFFIX.get(media, ".bin"))
        path.parent.mkdir(parents=True, exist_ok=True)
        # Written next to its destination and renamed, so a reader can never
        # open a half-written file under a name that promises those contents.
        tmp = path.with_suffix(path.suffix + ".part")
        tmp.write_bytes(raw)
        tmp.replace(path)
    return f"blob:{digest}"


def resolve(reference: str) -> tuple[Path, str] | None:
    """The file and media type behind a reference, or None if it is gone."""
    match = REF.match(reference.strip())
    if not match:
        return None
    path = _existing(match.group(1))
    if path is None:
        return None
    return path, _MEDIA.get(path.suffix, "application/octet-stream")


def to_refs(images: list[str] | None) -> list[str]:
    """Store what can be stored, and pass through what cannot.

    A value that is already a reference, or a URL pointing somewhere else, is
    left exactly as it was: this runs on every save, including saves of
    conversations that were stored before there was a blob directory.
    """
    out = []
    for image in images or []:
        out.append(store(image) or image)
    return out


def to_urls(images: list[str] | None) -> list[str]:
    """References become URLs the browser can put in an `<img src>`.

    Anything else is returned untouched, which is what lets a conversation
    saved before this existed keep rendering from its data URI.
    """
    out = []
    for image in images or []:
        match = REF.match(str(image).strip())
        out.append(f"/api/blobs/{match.group(1)}" if match else image)
    return out


def referenced() -> set[str]:
    """Every blob any message still points at."""
    from . import chats

    found: set[str] = set()
    with chats._connect() as conn:
        rows = conn.execute(
            "SELECT images FROM messages WHERE images IS NOT NULL"
        ).fetchall()
    for row in rows:
        try:
            images = json.loads(row["images"])
        except (TypeError, ValueError):
            continue
        for image in images or []:
            match = REF.match(str(image).strip())
            if match:
                found.add(match.group(1))
    return found


def sweep(dry_run: bool = True) -> dict:
    """Delete blobs nothing references any more.

    The replacement for the cascade that deleting a conversation used to get
    for free. Defaults to reporting rather than deleting, because the answer to
    "which files are unreferenced" is worth reading before it is acted on.
    """
    keep = referenced()
    removed, freed = 0, 0
    for path in DIR.glob("*/*"):
        if not path.is_file() or path.suffix == ".part":
            continue
        if path.stem in keep:
            continue
        freed += path.stat().st_size
        removed += 1
        if not dry_run:
            path.unlink()
    return {"removed": removed, "freed_bytes": freed, "kept": len(keep),
            "dry_run": dry_run}


def migrate(dry_run: bool = True) -> dict:
    """Move every inline data URI already in the database out to a file.

    Re-entrant: a row that already holds references is left alone, so an
    interrupted run is finished by running it again rather than by working out
    where it stopped. Nothing is deleted -- the row is rewritten to point at a
    file that was written first, and the bytes it used to hold are simply no
    longer there once the database is vacuumed.
    """
    from . import chats

    with chats._connect() as conn:
        rows = conn.execute(
            "SELECT id, images FROM messages WHERE images IS NOT NULL"
        ).fetchall()

        moved, rewritten, bytes_before = 0, 0, 0
        for row in rows:
            try:
                images = json.loads(row["images"])
            except (TypeError, ValueError):
                continue
            if not isinstance(images, list):
                continue

            converted, changed = [], False
            for image in images:
                text = str(image)
                reference = store(text) if not dry_run else (
                    f"blob:{hashlib.sha256(base64.b64decode(_DATA_URI.match(text).group(2))).hexdigest()}"
                    if _DATA_URI.match(text) else None
                )
                if reference:
                    bytes_before += len(text)
                    moved += 1
                    changed = True
                    converted.append(reference)
                else:
                    converted.append(text)

            if not changed:
                continue
            rewritten += 1
            if not dry_run:
                conn.execute(
                    "UPDATE messages SET images = ? WHERE id = ?",
                    (json.dumps(converted, ensure_ascii=False), row["id"]),
                )

    return {"messages": rewritten, "images": moved,
            "inline_chars_removed": bytes_before, "dry_run": dry_run}
