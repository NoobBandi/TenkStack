"""Browsing and filling the machine's directories.

This began as ComfyUI's model folders and nothing else. ComfyUI has no API for
putting files where they belong -- it can list what it found and accept an input
image under 100 MB, but a 20 GB checkpoint has always meant a shell on this
machine. That is still the main thing this does; it is simply no longer the only
tree it can reach.

WHAT IS REACHABLE IS CONFIGURED, NOT ASSUMED

The obvious implementation of "browse the disk" is to serve `/` and rely on the
process's own permissions. That is a mistake here, and not a small one. This
process runs as the owning user, who is in `sudo` and `docker`; the reachable
set therefore includes `~/.ssh`, and -- worse -- this console's own
`session.key`, whose bytes are the HMAC secret behind every session token.
Handing that file to anyone who can call this API turns "logged in" into
"permanently able to forge an administrator", which no password change undoes.

So two things hold, independently:

- ROOTS ARE DECLARED. `CONSOLE_FILE_ROOTS` names them, and the default set is a
  handful of directories rather than the whole disk. Serving `/` is available by
  setting it, which makes it a decision somebody made rather than a consequence
  of how the process happens to be started.
- A DENY LIST IS UNCONDITIONAL. It holds regardless of how the roots are
  configured, because a console should not be able to hand out its own keys. A
  denied path cannot be resolved into and does not appear in any listing.

Neither is a substitute for the other: the first bounds the normal case, the
second survives someone widening it.

PATHS, NOT A FLAT FOLDER LIST

An earlier version allowed one level, on the reasoning that ComfyUI's layout is
flat by convention. It is not: SaveVideo's default prefix is `video/MiniMax_H3`,
so outputs nest on their own, and model folders take subdirectories too. A
location here is a relative path, each segment validated separately.

LISTING IS ONE PASS AND COSTS NOTHING RECURSIVE

The version before this computed each subdirectory's recursive size while
listing, via `rglob`. Over a dozen model folders that is invisible; pointed at a
home directory it walks the entire disk on every navigation step. Sizes for
directories are now asked for one at a time, by a caller who wants that one
number, and the listing itself is a single `scandir`.

UPLOADS ARE RAW BODIES, NOT MULTIPART

Every byte is streamed from `request.stream()` straight to disk. The obvious
alternative, `UploadFile` with a multipart form, buffers the whole file: the
published benchmark has it at ~750-850 MB/s with memory growing to match the
upload, against ~1500 MB/s and a flat footprint for the streaming path. On a
20 GB safetensors those are different features, not different speeds.

UPLOADS ARE CHUNKED AND RESUMABLE

Bytes land in `<name>.part` and the file is renamed into place only when the
declared total has arrived, so a partial upload is never mistaken for a model.
The client sends an offset with every chunk and the server refuses anything that
does not match the length it already holds, answering with the length it does --
which is what makes a resume a normal request rather than a special case.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator, Iterator

from . import paths

COMFY_DIR = paths.COMFY_DIR


class BadPath(ValueError):
    """The caller asked for something outside the tree it was given."""


class Denied(BadPath):
    """The caller asked for something no configuration may expose."""


# --------------------------------------------------------------------------
# The deny list
# --------------------------------------------------------------------------

def _deny_list() -> list[Path]:
    """Paths that stay unreachable however the roots are configured.

    The console's own state comes first and is the reason this exists at all:
    `session.key` signs every session token and `console.sqlite` holds the
    password hashes and API keys. The rest are the credentials that a machine
    like this one accumulates -- SSH keys above all, since this host is reached
    over SSH and Tailscale.

    Resolved once per call rather than at import so that a symlinked home
    directory is followed the same way the request path will be.
    """
    home = Path.home()
    candidates = [
        paths.STATE_DIR,
        home / ".ssh",
        home / ".gnupg",
        home / ".aws",
        home / ".docker",
        home / ".kube",
        home / ".config/gh",
        home / ".config/gcloud",
        home / ".local/share/keyrings",
    ]
    extra = os.environ.get("CONSOLE_FILE_DENY", "")
    candidates += [Path(p).expanduser() for p in extra.split(":") if p.strip()]

    out = []
    for path in candidates:
        try:
            out.append(path.resolve())
        except OSError:
            continue
    return out


def _denied(final: Path) -> bool:
    """Whether a resolved path is the deny list or lives under it.

    Deliberately not the other direction: a denied directory being *inside* a
    root is the normal case -- `~/.ssh` sits in the home root -- and that root
    stays browsable. The entry is hidden from its listing instead.
    """
    for banned in _deny_list():
        if final == banned or banned in final.parents:
            return True
    return False


# --------------------------------------------------------------------------
# Roots
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Root:
    key: str
    label: str
    path: Path
    note: str
    readonly: bool = False


def _comfy_roots() -> list[Root]:
    """The three ComfyUI trees, which are why this module exists.

    Outputs are the one tree that is not shared: ComfyUI picks the next filename
    by scanning the directory for the highest counter, so two instances sharing
    one would collide by construction. run-comfyui.sh gives each its own
    `output-<name>`, and the names it used are the only record of what exists --
    so they are found rather than configured.
    """
    roots = [
        Root("models", "模型", COMFY_DIR / "storage-models/models",
             "checkpoints、loras、vae 等等。所有 ComfyUI 實例共用這一份。"),
        Root("input", "輸入", COMFY_DIR / "storage-user/input",
             "工作流讀得到的圖片與素材，所有實例共用。"),
    ]
    found = sorted(p for p in (COMFY_DIR / "storage-user").glob("output-*") if p.is_dir())
    for path in found:
        name = path.name[len("output-"):]
        roots.append(Root(
            f"output-{name}",
            f"輸出（{name}）" if len(found) > 1 else "輸出",
            path,
            "ComfyUI 寫出來的成品。每個實例一份，不共用。",
        ))
    return roots


def _configured_roots() -> list[Root] | None:
    """`CONSOLE_FILE_ROOTS`, or None when it is unset.

    Entries are separated by `;` and written `label=path`, with an optional
    `ro:` in front of the path to refuse writes regardless of what the
    filesystem would allow:

        CONSOLE_FILE_ROOTS='家目錄=~;整顆磁碟=ro:/'

    Setting this replaces the defaults rather than adding to them, which is the
    only behaviour that lets someone narrow the set. The ComfyUI trees are still
    appended -- they are what the page is for, and losing them by configuring an
    unrelated root would be a surprise.
    """
    raw = os.environ.get("CONSOLE_FILE_ROOTS", "").strip()
    if not raw:
        return None

    out: list[Root] = []
    for index, chunk in enumerate(raw.split(";")):
        chunk = chunk.strip()
        if not chunk:
            continue
        label, sep, spec = chunk.partition("=")
        if not sep:
            label, spec = "", chunk
        spec = spec.strip()
        readonly = spec.startswith("ro:")
        if readonly:
            spec = spec[3:]
        path = Path(spec).expanduser()
        out.append(Root(
            f"fs{index}",
            label.strip() or (path.name or str(path)),
            path,
            str(path),
            readonly,
        ))
    return out


def _default_roots() -> list[Root]:
    """A useful set that is not the whole disk.

    The home directory is here because it is where everything on this machine
    actually lives -- the models, the scripts, the llama.cpp checkout -- and
    because its owner is the person logged in. `/mnt` and `/media` appear only
    when something is mounted there, since an empty one is noise.
    """
    out = [Root("home", "家目錄", Path.home(), str(Path.home()))]
    for mount in (Path("/mnt"), Path("/media")):
        try:
            if mount.is_dir() and any(mount.iterdir()):
                out.append(Root(mount.name, str(mount), mount, f"掛載在 {mount} 底下的磁碟"))
        except OSError:
            continue
    return out


def _roots() -> dict[str, Root]:
    configured = _configured_roots()
    wide = configured if configured is not None else _default_roots()
    return {r.key: r for r in (*_comfy_roots(), *wide)}


def _root(key: str) -> Root:
    root = _roots().get(key)
    if root is None:
        raise BadPath(f"unknown root: {key}")
    return root


# --------------------------------------------------------------------------
# Resolution
# --------------------------------------------------------------------------

# A segment has to survive being joined to a directory and nothing more.
# Separators and traversal are rejected here to give a comprehensible error;
# the containment check on the resolved path is the one that actually holds.
# Note that a leading dot is allowed, unlike the version that only ever saw
# ComfyUI's folders -- a real disk is full of `.config` and `.cache`, and
# hiding them by refusing to name them would make them unreachable rather than
# tidy.
_SAFE_SEGMENT = re.compile(r"^[^/\\\x00]{1,255}$")

PART_SUFFIX = ".part"


def _check_segment(segment: str) -> str:
    if not _SAFE_SEGMENT.match(segment) or segment in (".", ".."):
        raise BadPath(f"bad name: {segment!r}")
    return segment


def resolve(root_key: str, path: str, name: str | None = None) -> Path:
    """Absolute path for a directory, or an entry inside it.

    `path` is relative to the root and may be empty, meaning the root itself.

    Both checks are done on the resolved path rather than on the input, because
    that is the only form that accounts for symlinks -- a link inside the tree
    pointing out of it would pass every check on the string.
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
    if _denied(final):
        raise Denied("這個位置主控台不提供存取")
    return final


def _writable(path: Path) -> bool:
    return path.is_dir() and os.access(path, os.W_OK | os.X_OK)


def _can_write(root: Root, path: Path) -> bool:
    return not root.readonly and _writable(path)


def roots() -> list[dict]:
    """The trees on offer, each with whether it can actually be written to.

    Reported rather than assumed because the ComfyUI directories are created by
    the container, which runs as root, while this process does not. An interface
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
            "writable": exists and _can_write(root, root.path),
        })
    return out


# --------------------------------------------------------------------------
# Listing
# --------------------------------------------------------------------------

def listing(root_key: str, path: str = "", hidden: bool = False) -> dict:
    """Everything at one location, in a single `scandir`.

    Directories and files come back in one list because they are one list on
    screen, and because separating them here meant walking the directory twice.

    Three things are deliberately visible rather than filtered out:

    - A `.part` is listed as the file it will become, marked incomplete. Hiding
      it would leave an upload invisible between the browser closing and the
      transfer finishing, and the half-written bytes are exactly what someone
      returning to a failed upload needs to see.
    - Anything that is neither a file nor a directory -- a device, a socket, a
      broken symlink -- is listed as `other`. Omitting them would make the
      listing disagree with `ls`, which is worse than showing something that
      cannot be opened. Nothing will read them: `/dev/zero` served as a download
      never ends.
    - Entries whose stat fails are listed with what is known. A permission error
      on one file is not a reason to fail the whole directory.
    """
    here = resolve(root_key, path)
    root = _root(root_key)
    if not here.is_dir():
        return {"entries": [], "writable": False, "free": 0}

    denied = _deny_list()
    entries: list[dict] = []
    with os.scandir(here) as scan:
        for entry in scan:
            name = entry.name
            is_hidden = name.startswith(".")
            if is_hidden and not hidden:
                continue

            try:
                resolved = Path(entry.path).resolve()
                if any(resolved == b or b in resolved.parents for b in denied):
                    continue
            except OSError:
                pass

            try:
                is_dir = entry.is_dir()
                stat = entry.stat()
                size, modified = stat.st_size, stat.st_mtime
            except OSError:
                entries.append({
                    "name": name, "kind": "other", "size": 0, "modified": 0,
                    "partial": False, "hidden": is_hidden,
                })
                continue

            if is_dir:
                kind = "dir"
            elif entry.is_file():
                kind = "file"
            else:
                kind = "other"

            partial = kind == "file" and name.endswith(PART_SUFFIX)
            entries.append({
                "name": name[: -len(PART_SUFFIX)] if partial else name,
                "kind": kind,
                # A directory's size on disk is its own inode, which is never
                # what anybody means by it. Sent as null so the column stays
                # empty until somebody asks for the real number.
                "size": None if kind == "dir" else size,
                "modified": modified,
                "partial": partial,
                "hidden": is_hidden,
            })

    entries.sort(key=lambda e: (e["kind"] != "dir", e["name"].lower()))
    return {
        "entries": entries,
        "writable": _can_write(root, here),
        "free": free_bytes(here),
        "readonly_root": root.readonly,
    }


def tree_size(root_key: str, path: str, name: str | None = None) -> dict:
    """How much is under one directory, walked on request.

    Separate from listing because it is the expensive question and almost never
    the one being asked. `scandir` rather than `rglob` because the latter builds
    Path objects for every entry on the way, which on a models directory is most
    of the time spent.
    """
    here = resolve(root_key, path, name)
    if not here.is_dir():
        return {"files": 0, "bytes": here.stat().st_size if here.is_file() else 0}

    files = total = 0
    stack = [here]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as scan:
                for entry in scan:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(Path(entry.path))
                        elif entry.is_file(follow_symlinks=False):
                            files += 1
                            total += entry.stat(follow_symlinks=False).st_size
                    except OSError:
                        continue
        except OSError:
            continue
    return {"files": files, "bytes": total}


# --------------------------------------------------------------------------
# Mutation
# --------------------------------------------------------------------------

def mkdir(root_key: str, path: str, name: str) -> dict:
    target = resolve(root_key, path, name)
    _refuse_readonly(root_key)
    if target.exists():
        raise FileExistsError(name)
    if not _writable(target.parent):
        raise PermissionError(str(target.parent))
    target.mkdir()
    return {"ok": True, "name": name}


def rename(root_key: str, path: str, name: str, to: str) -> dict:
    """A new name in the same directory.

    Only within one directory: moving between them is a separate call because it
    crosses a root boundary check, and folding the two together would make the
    common, safe operation carry the argument list of the rare one.
    """
    _refuse_readonly(root_key)
    source = resolve(root_key, path, name)
    target = resolve(root_key, path, to)
    if not source.exists():
        raise FileNotFoundError(name)
    if target.exists():
        raise FileExistsError(to)
    if not _writable(source.parent):
        raise PermissionError(str(source.parent))
    source.rename(target)
    return {"ok": True, "name": to}


def move(root_key: str, path: str, name: str, to_root: str, to_path: str) -> dict:
    """Into another directory, possibly under another root.

    `os.replace` would be wrong twice over: it overwrites silently, and it fails
    across filesystems. `shutil.move` falls back to a copy when the rename
    cannot be done, which is what makes moving a checkpoint from the home root
    into ComfyUI's models directory work at all when they are separate mounts.
    """
    _refuse_readonly(root_key)
    _refuse_readonly(to_root)
    source = resolve(root_key, path, name)
    destination = resolve(to_root, to_path)
    if not source.exists():
        raise FileNotFoundError(name)
    if not destination.is_dir():
        raise NotADirectoryError(to_path)
    if not _writable(destination):
        raise PermissionError(str(destination))
    if not _writable(source.parent):
        raise PermissionError(str(source.parent))

    target = destination / source.name
    if target.exists():
        raise FileExistsError(source.name)
    if source == destination or source in destination.parents:
        # Moving a directory inside itself produces an unreachable subtree and
        # no error, which is the worst combination available.
        raise BadPath("不能把資料夾移進它自己底下")
    shutil.move(str(source), str(target))
    return {"ok": True, "name": source.name}


def delete(root_key: str, path: str, name: str, partial: bool = False) -> dict:
    _refuse_readonly(root_key)
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
    if not target.exists():
        raise FileNotFoundError(name)
    size = target.stat().st_size if target.is_file() else 0
    target.unlink()
    return {"ok": True, "freed": size}


def _refuse_readonly(root_key: str) -> None:
    if _root(root_key).readonly:
        raise PermissionError("這個根目錄設定為唯讀")


# --------------------------------------------------------------------------
# Upload
# --------------------------------------------------------------------------

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
    _refuse_readonly(root_key)
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


# --------------------------------------------------------------------------
# Reading
# --------------------------------------------------------------------------

def open_file(root_key: str, path: str, name: str, partial: bool = False) -> tuple[Path, int]:
    """The path and length of something safe to send back.

    Regular files only. A device or a fifo would stream until the client gives
    up, and `/dev/zero` is reachable from a root of `/`.
    """
    target = resolve(root_key, path, name)
    if partial:
        target = target.with_name(target.name + PART_SUFFIX)
    if not target.is_file():
        raise FileNotFoundError(name)
    stat = target.stat()
    return target, stat.st_size


def stream(path: Path, start: int, length: int, block: int = 1 << 20) -> Iterator[bytes]:
    """Bytes from an offset, for a length. The shape a 206 needs."""
    with path.open("rb") as handle:
        handle.seek(start)
        remaining = length
        while remaining > 0:
            chunk = handle.read(min(block, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


# --------------------------------------------------------------------------
# Peeking inside model files
# --------------------------------------------------------------------------

_SAFETENSORS_MAX_HEADER = 64 << 20


def _peek_safetensors(handle) -> dict:
    """Tensor names, shapes and dtypes from the first few kilobytes.

    The format puts an 8-byte little-endian header length at offset 0 followed
    by that many bytes of JSON. Everything worth showing about a 20 GB
    checkpoint is in there, so this reads a few hundred kilobytes at most.
    """
    raw = handle.read(8)
    if len(raw) < 8:
        raise ValueError("檔案太短，不是 safetensors")
    (length,) = struct.unpack("<Q", raw)
    if not 0 < length <= _SAFETENSORS_MAX_HEADER:
        raise ValueError("safetensors 標頭長度不合理")

    header = json.loads(handle.read(length).decode("utf-8"))
    meta = _trim_metadata(header.pop("__metadata__", None))

    tensors = []
    params = 0
    for key, value in header.items():
        shape = value.get("shape", [])
        count = 1
        for dim in shape:
            count *= dim
        params += count
        tensors.append({"name": key, "dtype": value.get("dtype"), "shape": shape})
    tensors.sort(key=lambda t: t["name"])

    return {
        "format": "safetensors",
        "tensors": tensors[:_TENSOR_LIMIT],
        "truncated": len(tensors) > _TENSOR_LIMIT,
        "count": len(tensors),
        "parameters": params,
        "metadata": meta,
    }


# Enough to see the shape of any model anyone puts here, bounded so that a
# pathological file cannot make the response the size of the header.
_TENSOR_LIMIT = 4000
_META_STRING_LIMIT = 2048
_THUMBNAIL_LIMIT = 512 * 1024


def _trim_metadata(meta) -> dict | None:
    """Metadata worth sending, at a size worth sending.

    Two things in here are large for opposite reasons. `modelspec.thumbnail` is
    a base64 data URI of the model's own preview image -- 40 KB for the Stable
    Diffusion checkpoint on this machine -- and is exactly what a file browser
    wants to show, so it survives. Everything else that runs long is a training
    log or a merge recipe, which nobody reads in a side panel, so it is cut.
    """
    if not isinstance(meta, dict):
        return None
    out = {}
    for key, value in meta.items():
        if isinstance(value, str) and len(value) > _META_STRING_LIMIT:
            if value.startswith("data:image/") and len(value) <= _THUMBNAIL_LIMIT:
                out[key] = value
            else:
                out[key] = value[:_META_STRING_LIMIT] + f"…（共 {len(value)} 字元）"
        else:
            out[key] = value
    return out


_GGUF_MAGIC = b"GGUF"


def _gguf_value(handle, kind: int):
    """One metadata value, by GGUF's type tag.

    Arrays nest, which is why this is recursive: `tokenizer.ggml.tokens` is an
    array of 150k strings, and the caller drops it rather than the reader
    refusing to parse it.
    """
    simple = {
        0: ("<B", 1), 1: ("<b", 1), 2: ("<H", 2), 3: ("<h", 2),
        4: ("<I", 4), 5: ("<i", 4), 6: ("<f", 4), 7: ("<?", 1),
        10: ("<Q", 8), 11: ("<q", 8), 12: ("<d", 8),
    }
    if kind in simple:
        fmt, size = simple[kind]
        return struct.unpack(fmt, handle.read(size))[0]
    if kind == 8:  # string
        (length,) = struct.unpack("<Q", handle.read(8))
        return handle.read(length).decode("utf-8", "replace")
    if kind == 9:  # array
        (inner,) = struct.unpack("<I", handle.read(4))
        (count,) = struct.unpack("<Q", handle.read(8))
        return [_gguf_value(handle, inner) for _ in range(count)]
    raise ValueError(f"unknown gguf value type {kind}")


def _peek_gguf(handle) -> dict:
    """Architecture, quantisation and context length without loading weights.

    The interesting keys are all in the metadata block at the head of the file.
    Token lists are read (the format gives no way to skip a value without
    parsing it) but dropped, since a 150k-entry array is not something to send
    to a browser.
    """
    if handle.read(4) != _GGUF_MAGIC:
        raise ValueError("不是 GGUF 檔")
    version, tensor_count, kv_count = struct.unpack("<IQQ", handle.read(20))

    meta: dict = {}
    for _ in range(kv_count):
        (length,) = struct.unpack("<Q", handle.read(8))
        key = handle.read(length).decode("utf-8", "replace")
        (kind,) = struct.unpack("<I", handle.read(4))
        value = _gguf_value(handle, kind)
        if isinstance(value, list) and len(value) > 32:
            value = f"[{len(value)} 個項目]"
        meta[key] = value

    return {
        "format": "gguf",
        "version": version,
        "count": tensor_count,
        "metadata": meta,
    }


# Text that is worth showing inline. Extensions rather than sniffing, because a
# wrong guess here renders a binary as mojibake rather than failing.
TEXT_SUFFIXES = {
    ".txt", ".md", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
    ".csv", ".tsv", ".log", ".py", ".js", ".ts", ".tsx", ".jsx", ".sh", ".bash",
    ".c", ".h", ".cpp", ".hpp", ".rs", ".go", ".sql", ".html", ".css", ".xml",
    ".env", ".gitignore", ".service", ".Caddyfile",
}

TEXT_HEAD = 256 * 1024


def peek(root_key: str, path: str, name: str) -> dict:
    """What can be said about a file without reading all of it.

    Three answers exist: a model file's header, the first page of a text file,
    or nothing -- and "nothing" is a real answer for a 20 GB video, not a
    failure. The caller decides what to draw.
    """
    target, size = open_file(root_key, path, name)
    suffix = target.suffix.lower()

    try:
        if suffix == ".safetensors":
            with target.open("rb") as handle:
                return {"kind": "model", "size": size, **_peek_safetensors(handle)}
        if suffix == ".gguf":
            with target.open("rb") as handle:
                return {"kind": "model", "size": size, **_peek_gguf(handle)}
    except (ValueError, OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        return {"kind": "unreadable", "size": size, "detail": str(exc)}

    if suffix in TEXT_SUFFIXES or (suffix == "" and size < TEXT_HEAD):
        with target.open("rb") as handle:
            raw = handle.read(TEXT_HEAD)
        if b"\0" in raw:
            return {"kind": "binary", "size": size}
        return {
            "kind": "text",
            "size": size,
            "text": raw.decode("utf-8", "replace"),
            "truncated": size > TEXT_HEAD,
            "language": suffix[1:] if suffix else "",
        }

    return {"kind": "binary", "size": size}


def free_bytes(path: Path) -> int:
    """Room left on the filesystem holding this location, so the UI can refuse a
    24 GB upload onto 3 GB of space before spending twenty minutes on it."""
    while not path.exists() and path != path.parent:
        path = path.parent
    try:
        return shutil.disk_usage(path).free
    except OSError:
        return 0
