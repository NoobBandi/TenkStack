"""Browsing and filling ComfyUI's model, input and output folders.

ComfyUI has no API for this. It can list what it found (`/models/{folder}`) and
accept an input image under 100 MB (`/upload/image`), but there is no way to put
a 20 GB checkpoint where it belongs except reaching the filesystem -- which so
far has meant a shell on this machine. That is the gap this fills.

PATHS, NOT A FLAT FOLDER LIST

An earlier version allowed one level, on the reasoning that ComfyUI's layout is
flat by convention. It is not: SaveVideo's default prefix is `video/MiniMax_H3`,
so outputs nest on their own, and model folders take subdirectories too. So a
location here is a relative path, each segment validated separately, and the
interface navigates it.

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
from . import paths

COMFY_DIR = paths.COMFY_DIR


@dataclass(frozen=True)
class Root:
    key: str
    label: str
    path: Path
    note: str


_FIXED = (
    Root(
        "models", "模型",
        COMFY_DIR / "storage-models/models",
        "checkpoints、loras、vae 等等。所有 ComfyUI 實例共用這一份。",
    ),
    Root(
        "input", "輸入",
        COMFY_DIR / "storage-user/input",
        "工作流讀得到的圖片與素材，所有實例共用。",
    ),
)


def _output_roots() -> list[Root]:
    """One per instance, found rather than configured.

    Outputs are the one tree that is not shared: ComfyUI picks the next filename
    by scanning the directory for the highest counter, so two instances sharing
    one would collide by construction. run-comfyui.sh gives each its own
    `output-<name>`, and the names it used are the only record of what exists.
    """
    parent = COMFY_DIR / "storage-user"
    found = sorted(p for p in parent.glob("output-*") if p.is_dir())
    return [
        Root(
            f"output-{p.name[len('output-'):]}",
            f"輸出（{p.name[len('output-'):]}）" if len(found) > 1 else "輸出",
            p,
            "ComfyUI 寫出來的成品。每個實例一份，不共用。",
        )
        for p in found
    ]


def _roots() -> dict[str, Root]:
    return {r.key: r for r in (*_FIXED, *_output_roots())}


# A segment has to survive being joined to a directory and nothing more.
# Rejecting separators and dotfiles is stricter than checking the resolved path
# stays inside the root, and both are applied -- the first gives a
# comprehensible error, the second is the one that actually holds.
_SAFE_SEGMENT = re.compile(r"^[^/\\\x00]{1,255}$")

PART_SUFFIX = ".part"


class BadPath(ValueError):
    """The caller asked for something outside the tree it was given."""


def _root(key: str) -> Root:
    root = _roots().get(key)
    if root is None:
        raise BadPath(f"unknown root: {key}")
    return root


def _check_segment(segment: str) -> str:
    if not _SAFE_SEGMENT.match(segment) or segment in (".", "..") or segment.startswith("."):
        raise BadPath(f"bad name: {segment!r}")
    return segment


def resolve(root_key: str, path: str, name: str | None = None) -> Path:
    """Absolute path for a directory, or a file inside it.

    `path` is relative to the root and may be empty, meaning the root itself.

    The containment check is done on the resolved path rather than on the input,
    because that is the only form that accounts for symlinks -- a link inside
    the tree pointing out of it would pass every check on the string.
    """
    root = _root(root_key)
    target = root.path
    for segment in (path or "").split("/"):
        if segment:
            target = target / _check_segment(segment)
    if name is not None:
        target = target / _check_segment(name)

    base = root.path.resolve()
    final = target.resolve()
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
    for root in _roots().values():
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


def _tree_size(path: Path) -> tuple[int, int]:
    count = size = 0
    for child in path.rglob("*"):
        if child.is_file():
            count += 1
            size += child.stat().st_size
    return count, size


def folders(root_key: str, path: str = "") -> list[dict]:
    """Immediate subdirectories of one location, with what is under each."""
    here = resolve(root_key, path)
    if not here.is_dir():
        return []

    out: list[dict] = []
    for entry in sorted(here.iterdir(), key=lambda p: p.name.lower()):
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        count, size = _tree_size(entry)
        out.append({
            "name": entry.name,
            "files": count,
            "size": size,
            "writable": _writable(entry),
        })
    return out


def listing(root_key: str, path: str = "") -> dict:
    """Files at one location, uploads in progress included.

    A `.part` is listed as the file it will become, marked incomplete. Hiding it
    would leave an upload invisible between the browser closing and the transfer
    finishing, and the half-written bytes are exactly what someone coming back
    to a failed upload needs to see.
    """
    here = resolve(root_key, path)
    if not here.is_dir():
        return {"files": [], "writable": False}

    files: list[dict] = []
    for entry in sorted(here.iterdir(), key=lambda p: p.name.lower()):
        if not entry.is_file() or entry.name.startswith("."):
            continue
        stat = entry.stat()
        partial = entry.name.endswith(PART_SUFFIX)
        files.append({
            "name": entry.name[: -len(PART_SUFFIX)] if partial else entry.name,
            "size": stat.st_size,
            "modified": stat.st_mtime,
            "partial": partial,
        })
    return {"files": files, "writable": _writable(here)}


def mkdir(root_key: str, path: str, name: str) -> dict:
    target = resolve(root_key, path, name)
    if target.exists():
        raise FileExistsError(name)
    if not _writable(target.parent):
        raise PermissionError(str(target.parent))
    target.mkdir()
    return {"ok": True, "name": name}


def upload_offset(root_key: str, path: str, name: str) -> dict:
    """How much of this file the server already holds.

    Three answers, and they are different: nothing yet, a part-file of some
    length to resume from, or a finished file that would be overwritten.
    """
    target = resolve(root_key, path, name)
    part = target.with_name(target.name + PART_SUFFIX)
    if target.exists():
        return {"offset": 0, "exists": True, "size": target.stat().st_size}
    return {"offset": part.stat().st_size if part.exists() else 0, "exists": False}


async def receive(
    root_key: str,
    path: str,
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
    target = resolve(root_key, path, name)
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


def delete(root_key: str, path: str, name: str, partial: bool = False) -> dict:
    target = resolve(root_key, path, name)
    if partial:
        target = target.with_name(target.name + PART_SUFFIX)
    if target.is_dir():
        # Only when nothing is inside. Recursively deleting a directory of
        # models from a web page is a bigger promise than this makes.
        try:
            target.rmdir()
        except OSError:
            raise IsADirectoryError(name)
        return {"ok": True, "freed": 0}
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
