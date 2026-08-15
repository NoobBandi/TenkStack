"""Browsing and filling ComfyUI's model and input folders.

ComfyUI has no API for this. It can list what it found (`/models/{folder}`) and
accept an input image under 100 MB (`/upload/image`), but there is no way to put
a 20 GB checkpoint where it belongs except reaching the filesystem -- which so
far has meant a shell on this machine. That is the gap this fills.

UPLOADS ARE RAW BODIES, NOT MULTIPART

Every byte is streamed from `request.stream()` straight to disk. The obvious
alternative, `UploadFile` with a multipart form, buffers the whole file: the
published benchmark has it at ~750-850 MB/s with memory growing to match the
upload, against ~1500 MB/s and a flat footprint for the streaming path. On a
20 GB safetensors those are different features, not different speeds. It also
happens that `python-multipart` is not installed here, so the slow path is not
even reachable without adding a dependency to be slower.

UPLOADS ARE CHUNKED AND RESUMABLE

Bytes land in `<name>.part` and the file is renamed into place only when the
declared total has arrived, so a partial upload is never mistaken for a model.
The client sends an offset with every chunk and the server refuses anything that
does not match the length it already holds, answering with the length it does --
which is what makes a resume a normal request rather than a special case. A
dropped connection costs one chunk.

Caddy streams request bodies by default and no size limit is configured in front
of this, so the transfer arrives here as fast as the network allows.
"""

from __future__ import annotations

import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator

COMFY_DIR = Path("/home/tenk/ai/comfyui")


@dataclass(frozen=True)
class Root:
    key: str
    label: str
    path: Path
    note: str


# Only the two trees worth filling by hand. Outputs are not here: they are the
# gallery's subject, they are written by ComfyUI rather than by anyone, and they
# are per instance while these two are shared by all of them.
ROOTS: dict[str, Root] = {
    root.key: root
    for root in (
        Root(
            "models", "模型",
            COMFY_DIR / "storage-models/models",
            "checkpoints、loras、vae 等等。所有 ComfyUI 實例共用這一份。",
        ),
        Root(
            "input", "輸入",
            COMFY_DIR / "storage-user/input",
            "工作流讀得到的圖片與素材。",
        ),
    )
}

# A name has to survive being joined to a directory and nothing more. Rejecting
# separators and dots outright is stricter than checking the resolved path stays
# inside the root, and both are applied -- the first gives a comprehensible
# error, the second is the one that actually holds.
_SAFE_NAME = re.compile(r"^[^/\\\x00]{1,255}$")

PART_SUFFIX = ".part"


class BadPath(ValueError):
    """The caller asked for something outside the tree it was given."""


def _root(key: str) -> Root:
    root = ROOTS.get(key)
    if root is None:
        raise BadPath(f"unknown root: {key}")
    return root


def _check_name(name: str) -> str:
    if not _SAFE_NAME.match(name) or name in (".", "..") or name.startswith("."):
        raise BadPath(f"bad name: {name!r}")
    return name


def resolve(root_key: str, folder: str, name: str | None = None) -> Path:
    """Absolute path for a folder, or a file inside it.

    The containment check is done on the resolved path rather than on the
    input, because that is the only form that accounts for symlinks -- a link
    inside the tree pointing out of it would pass every check on the string.
    """
    root = _root(root_key)
    path = root.path
    if folder:
        path = path / _check_name(folder)
    if name is not None:
        path = path / _check_name(name)

    base = root.path.resolve()
    final = path.resolve()
    if final != base and base not in final.parents:
        raise BadPath("path escapes its root")
    return final


def _writable(path: Path) -> bool:
    return path.is_dir() and os.access(path, os.W_OK | os.X_OK)


def roots() -> list[dict]:
    """The trees on offer, each with whether it can actually be written to.

    Reported rather than assumed because these directories are created by the
    container, which runs as root, while this process does not. An interface
    that offers an upload button over a read-only directory is worse than one
    that explains itself.
    """
    out = []
    for root in ROOTS.values():
        exists = root.path.is_dir()
        out.append({
            "key": root.key,
            "label": root.label,
            "note": root.note,
            "path": str(root.path),
            "exists": exists,
            "writable": exists and _writable(root.path),
        })
    return out


def folders(root_key: str) -> list[dict]:
    """Immediate subdirectories, with what is in each.

    One level only. ComfyUI's own folder set is flat by convention and a tree
    view here would be a second navigation model for no gain -- everything that
    matters is `checkpoints`, `loras`, `vae` and their siblings.
    """
    root = _root(root_key)
    if not root.path.is_dir():
        return []

    out: list[dict] = []
    for entry in sorted(root.path.iterdir(), key=lambda p: p.name.lower()):
        if not entry.is_dir():
            continue
        count = 0
        size = 0
        for child in entry.rglob("*"):
            if child.is_file():
                count += 1
                size += child.stat().st_size
        out.append({
            "name": entry.name,
            "files": count,
            "size": size,
            "writable": _writable(entry),
        })
    return out


def listing(root_key: str, folder: str) -> list[dict]:
    """Files in one folder, uploads in progress included.

    A `.part` is listed as the file it will become, marked incomplete. Hiding it
    would leave an upload invisible between the browser closing and the transfer
    finishing, and the half-written bytes are exactly what someone coming back
    to a failed upload needs to see.
    """
    path = resolve(root_key, folder)
    if not path.is_dir():
        return []

    out: list[dict] = []
    for entry in sorted(path.iterdir(), key=lambda p: p.name.lower()):
        if not entry.is_file():
            continue
        stat = entry.stat()
        partial = entry.name.endswith(PART_SUFFIX)
        out.append({
            "name": entry.name[: -len(PART_SUFFIX)] if partial else entry.name,
            "size": stat.st_size,
            "modified": stat.st_mtime,
            "partial": partial,
        })
    return out


def upload_offset(root_key: str, folder: str, name: str) -> dict:
    """How much of this file the server already holds.

    Three answers, and they are different: nothing yet, a part-file of some
    length to resume from, or a finished file that would be overwritten.
    """
    target = resolve(root_key, folder, name)
    part = target.with_name(target.name + PART_SUFFIX)
    if target.exists():
        return {"offset": 0, "exists": True, "size": target.stat().st_size}
    return {"offset": part.stat().st_size if part.exists() else 0, "exists": False}


async def receive(
    root_key: str,
    folder: str,
    name: str,
    offset: int,
    total: int,
    body: AsyncIterator[bytes],
) -> dict:
    """Append one chunk, finishing the file when the declared total is reached.

    Raises FileExistsError if the destination is already there. Overwriting a
    model in place is not something to do by accident: a workflow referring to
    it by name would silently start producing different pictures.
    """
    target = resolve(root_key, folder, name)
    if target.exists():
        raise FileExistsError(name)
    if not _writable(target.parent):
        raise PermissionError(str(target.parent))

    part = target.with_name(target.name + PART_SUFFIX)
    have = part.stat().st_size if part.exists() else 0
    if offset != have:
        # Not an error the client can do anything with unless it is told what
        # the server actually has, so the length goes back with the refusal and
        # the next request is an ordinary one.
        return {"ok": False, "expected": have}

    # Plain writes rather than a thread pool: these land in the page cache, and
    # a 16 MiB chunk arrives as a few hundred of them. Nothing here calls fsync,
    # so none of it waits on the disk.
    with part.open("ab") as handle:
        async for block in body:
            handle.write(block)

    written = part.stat().st_size
    if written < total:
        return {"ok": True, "offset": written, "done": False}
    if written > total:
        part.unlink(missing_ok=True)
        raise ValueError(f"received {written} bytes for a declared {total}")

    part.rename(target)
    return {"ok": True, "offset": written, "done": True}


def delete(root_key: str, folder: str, name: str, partial: bool = False) -> dict:
    target = resolve(root_key, folder, name)
    if partial:
        target = target.with_name(target.name + PART_SUFFIX)
    if not target.is_file():
        raise FileNotFoundError(name)
    size = target.stat().st_size
    target.unlink()
    return {"ok": True, "freed": size}


def free_bytes(root_key: str) -> int:
    """Room left on the filesystem holding this tree, so the UI can refuse a
    24 GB upload onto 3 GB of space before spending twenty minutes on it."""
    root = _root(root_key)
    path = root.path if root.path.exists() else root.path.parent
    return shutil.disk_usage(path).free
