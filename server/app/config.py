"""Model management by editing llama-swap's config.yaml.

llama-swap has no API for adding or changing models, but it does have
-watch-config. So the config file *is* the management interface, and this module
is the only thing allowed to write it.

ruamel.yaml in round-trip mode, not PyYAML, because that file carries the
comments explaining the VRAM policy. A plain safe_load/safe_dump cycle would
silently delete every one of them on the first edit made through the UI.
"""

from __future__ import annotations

import asyncio
import io
import logging
import re
import shutil
from pathlib import Path
from typing import Any

from ruamel.yaml import YAML
from ruamel.yaml.scalarstring import LiteralScalarString
from . import paths

logger = logging.getLogger(__name__)

CONFIG_PATH = paths.LLAMA_SWAP_CONFIG
MODELS_DIR = paths.MODELS_DIR
WRAPPER = "${llama-sycl}"

_yaml = YAML()
_yaml.preserve_quotes = True
_yaml.indent(mapping=2, sequence=4, offset=2)

# Serialises writes. Two concurrent edits would otherwise interleave a
# read-modify-write and lose one of them.
_lock = asyncio.Lock()


def _load() -> Any:
    with CONFIG_PATH.open(encoding="utf-8") as handle:
        return _yaml.load(handle)


def _dump(data: Any) -> None:
    """Write via a temp file and replace, so a crash mid-write cannot leave
    llama-swap watching a truncated config.

    The rendered text is parsed back before it is allowed anywhere near the real
    file. Round-tripping comments is not always safe: emptying a commented
    mapping makes ruamel print the orphaned comments and then a bare `{}` at
    column zero, which is unparseable. That produced a config llama-swap could
    not read, and the failure only surfaced on its next restart -- long after
    the action that caused it. Verifying here turns that into an error at the
    point of the edit.
    """
    buffer = io.StringIO()
    _yaml.dump(data, buffer)
    text = buffer.getvalue()

    try:
        YAML().load(text)
    except Exception as exc:
        logger.error("refusing to write a config that does not parse: %s", exc)
        raise ValueError(
            "產生的設定檔無法解析，已保留原檔未修改。"
        ) from exc

    tmp = CONFIG_PATH.with_suffix(".yaml.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(CONFIG_PATH)


def read() -> dict:
    data = _load()
    return {
        "models": dict(data.get("models") or {}),
        "groups": dict(data.get("groups") or {}),
        "path": str(CONFIG_PATH),
    }


def raw() -> str:
    return CONFIG_PATH.read_text(encoding="utf-8")


async def write_raw(text: str) -> None:
    """Replace the whole file, after checking it parses.

    Saving a config that llama-swap cannot read would take model serving down
    until someone edited the file by hand, so a parse failure is refused here
    rather than discovered by the watcher.
    """
    _yaml.load(text)  # raises on malformed YAML
    async with _lock:
        backup = CONFIG_PATH.with_suffix(".yaml.bak")
        shutil.copy2(CONFIG_PATH, backup)
        CONFIG_PATH.write_text(text, encoding="utf-8")


def build_cmd(
    model_file: str,
    ctx_size: int = 16384,
    n_gpu_layers: int = 99,
    extra: str = "",
    mmproj: str | None = None,
) -> str:
    """Assemble a llama-server command line.

    --n-gpu-layers is written explicitly but defaults to 99 rather than being
    omitted: llama.cpp refuses to auto-fit when the flag is present, so leaving
    it out is the right choice for models that do not fit, and the UI has to be
    able to clear it. Callers pass 0 to mean "let llama.cpp decide".
    """
    lines = [
        WRAPPER,
        f"--model ${{models-dir}}/{model_file}",
        "--host 127.0.0.1 --port ${PORT}",
    ]
    if n_gpu_layers:
        lines.append(f"--n-gpu-layers {n_gpu_layers}")
    lines.append(f"--ctx-size {ctx_size}")
    lines.append("--jinja")
    if mmproj:
        lines.append(f"--mmproj ${{models-dir}}/{mmproj}")
    if extra.strip():
        lines.extend(line.strip() for line in extra.strip().splitlines() if line.strip())
    # A literal block scalar, not a plain str: otherwise ruamel emits the command
    # as a quoted one-liner full of \n escapes, and the Settings page exists
    # precisely so this file can be read and edited by hand.
    return LiteralScalarString("\n".join(lines) + "\n")


async def upsert_model(
    model_id: str,
    *,
    name: str,
    description: str,
    model_file: str,
    ctx_size: int,
    n_gpu_layers: int,
    ttl: int,
    group: str | None,
    extra: str = "",
    mmproj: str | None = None,
) -> None:
    async with _lock:
        data = _load()
        models = data.setdefault("models", {})
        models[model_id] = {
            "name": name,
            "description": description,
            "cmd": build_cmd(model_file, ctx_size, n_gpu_layers, extra, mmproj),
            "ttl": ttl,
        }
        _sync_group_membership(data, model_id, group)
        _dump(data)
    logger.info("upserted model %s (group=%s)", model_id, group)


# Pulls GGUF paths out of a cmd block. The whole token, not just the basename:
# weights downloaded from Hugging Face now land under `<owner>/<repo>/`, because
# two repos publishing the same quant of the same model under the same filename
# is the normal case rather than a collision worth ignoring. A basename is no
# longer an identity.
_FILE_FLAGS = re.compile(r"--(?:model|mmproj)\s+(\S+\.gguf)")

# `${models-dir}/…`, which is llama-swap's macro for exactly this directory.
_MACRO = re.compile(r"^\$\{[^}]+\}/")


def _files_in_cmd(cmd: Any) -> set[str]:
    """Every GGUF a model entry references, relative to the models directory.

    A path that is neither relative nor under the macro belongs to somebody's
    own arrangement -- weights on another mount, say -- and is reduced to its
    basename, which is what this returned for everything before. It will not
    resolve to a file here, and that is the honest answer: this module cannot
    manage what it was not given.
    """
    out = set()
    for token in _FILE_FLAGS.findall(str(cmd or "")):
        relative = _MACRO.sub("", token)
        out.add(Path(relative).name if relative.startswith("/") else relative)
    return out


def _resolve_model_path(relative: str) -> Path | None:
    """`MODELS_DIR / relative`, or None if that escapes the directory.

    Now that these are paths rather than names, `..` has to be refused
    somewhere, and refusing it here covers deletion, listing and reference
    counting at once.
    """
    candidate = (MODELS_DIR / relative).resolve()
    base = MODELS_DIR.resolve()
    if candidate != base and base not in candidate.parents:
        return None
    return candidate


_CTX_FLAG = re.compile(r"--ctx-size\s+(\d+)")

# Sampling flags a model entry may carry, mapped to the names the chat panel
# and the OpenAI API use. llama.cpp normalises underscores to hyphens, so both
# spellings are accepted here -- and `repeat-penalty` is included under its
# llama.cpp name because that is what the config has to say, whatever the API
# calls it.
_SAMPLING_FLAGS = {
    "temp": "temperature",
    "temperature": "temperature",
    "top-p": "top_p",
    "top-k": "top_k",
    "min-p": "min_p",
    "presence-penalty": "presence_penalty",
    "frequency-penalty": "frequency_penalty",
    "repeat-penalty": "repeat_penalty",
}
_SAMPLING_INTS = {"top_k"}


def sampling_defaults() -> dict[str, dict[str, float]]:
    """Each model's sampling flags, so the chat panel can start from what the
    model was actually configured with.

    These flags are only defaults on the server -- a request that carries its
    own values overrides them entirely, which is exactly what the console does.
    So without reading them here the panel and the config drift apart silently,
    and the numbers written in config.yaml never take effect for the one client
    that matters most.
    """
    try:
        models = _load().get("models") or {}
    except Exception:
        logger.exception("could not read the config while reading sampling defaults")
        return {}

    out: dict[str, dict[str, float]] = {}
    for model_id, spec in models.items():
        cmd = str(spec.get("cmd") or "")
        found: dict[str, float] = {}
        for flag, name in _SAMPLING_FLAGS.items():
            # Underscores and hyphens both, since llama.cpp accepts both and the
            # config is written by hand.
            pattern = flag.replace("-", "[-_]")
            match = re.search(rf"--{pattern}\s+(-?[\d.]+)", cmd)
            if match:
                try:
                    value = float(match.group(1))
                except ValueError:
                    continue
                found[name] = int(value) if name in _SAMPLING_INTS else value
        if found:
            out[model_id] = found
    return out
_MMPROJ_FLAG = re.compile(r"--mmproj\s+\S+")


def declared_vision() -> dict[str, bool]:
    """Whether each model's command line asks for an mmproj.

    Only a declaration. A model that is running reports the truth through
    /props; this is what the UI falls back on for models that are stopped.
    """
    try:
        models = _load().get("models") or {}
    except Exception:
        logger.exception("could not read the config while checking for mmproj")
        return {}
    return {
        model_id: bool(_MMPROJ_FLAG.search(str(spec.get("cmd") or "")))
        for model_id, spec in models.items()
    }


def context_sizes() -> dict[str, int]:
    """Each model's --ctx-size, so the UI can show context used against its real
    limit instead of a number the user has to remember."""
    try:
        models = _load().get("models") or {}
    except Exception:
        logger.exception("could not read the config while reading context sizes")
        return {}

    sizes = {}
    for model_id, spec in models.items():
        match = _CTX_FLAG.search(str(spec.get("cmd") or ""))
        if match:
            sizes[model_id] = int(match.group(1))
    return sizes


def files_for_model(model_id: str) -> list[dict]:
    """The GGUF files a model entry points at, with size and sharing status.

    `shared_with` matters: the same weights can back several entries (one per
    context length, say), and deleting the file out from under the others would
    break them silently. The caller decides what to do; this only reports it.
    """
    data = _load()
    models = data.get("models") or {}
    spec = models.get(model_id)
    if spec is None:
        return []

    result = []
    for filename in sorted(_files_in_cmd(spec.get("cmd"))):
        others = sorted(
            other_id for other_id, other in models.items()
            if other_id != model_id and filename in _files_in_cmd(other.get("cmd"))
        )
        path = _resolve_model_path(filename)
        exists = bool(path and path.is_file())
        result.append({
            "filename": filename,
            "exists": exists,
            "size_bytes": path.stat().st_size if exists else 0,
            "shared_with": others,
        })
    return result


async def delete_model(model_id: str, delete_files: bool = False) -> dict | None:
    """Remove a model entry, optionally deleting its GGUF files.

    Files still referenced by another entry are always kept, no matter what was
    asked: honouring the request literally would leave the remaining entry
    pointing at nothing, and a silently broken model is worse than a file left
    on disk.
    """
    async with _lock:
        data = _load()
        models = data.get("models") or {}
        if model_id not in models:
            return None

        candidates = files_for_model(model_id) if delete_files else []
        del models[model_id]
        _sync_group_membership(data, model_id, None)
        _dump(data)

    deleted: list[dict] = []
    kept: list[dict] = []
    for entry in candidates:
        if entry["shared_with"]:
            kept.append({"filename": entry["filename"],
                         "reason": f"仍被 {', '.join(entry['shared_with'])} 使用"})
            continue
        path = _resolve_model_path(entry["filename"])
        if path is None:
            kept.append({"filename": entry["filename"], "reason": "路徑不在模型目錄底下"})
            continue
        try:
            path.unlink()
            _prune_empty(path.parent)
            deleted.append({"filename": entry["filename"], "size_bytes": entry["size_bytes"]})
            logger.info("deleted %s (%.1f GiB)", path.name, entry["size_bytes"] / 1024**3)
        except FileNotFoundError:
            kept.append({"filename": entry["filename"], "reason": "檔案不存在"})
        except OSError as exc:
            kept.append({"filename": entry["filename"], "reason": str(exc)})
            logger.warning("could not delete %s: %s", path, exc)

    logger.info("deleted model %s (files: %d removed, %d kept)", model_id, len(deleted), len(kept))
    return {"deleted": deleted, "kept": kept}


def delete_file(filename: str) -> dict:
    """Delete one GGUF from disk, refusing if a model still points at it."""
    # A relative path now, not a basename, since weights sit under
    # `<owner>/<repo>/`. Containment is checked on the resolved path rather than
    # by stripping directories -- which is what used to keep this safe and would
    # now delete the wrong file, given two repos may publish the same name.
    path = _resolve_model_path(filename)
    if path is None:
        return {"ok": False, "reason": "路徑不在模型目錄底下"}
    if not path.is_file():
        return {"ok": False, "reason": "檔案不存在"}

    data = _load()
    users_of_file = sorted(
        model_id for model_id, spec in (data.get("models") or {}).items()
        if filename in _files_in_cmd(spec.get("cmd"))
    )
    if users_of_file:
        return {"ok": False, "reason": f"仍被 {', '.join(users_of_file)} 使用"}

    size = path.stat().st_size
    try:
        path.unlink()
        _prune_empty(path.parent)
    except OSError as exc:
        return {"ok": False, "reason": str(exc)}
    logger.info("deleted orphan file %s (%.1f GiB)", filename, size / 1024**3)
    return {"ok": True, "filename": filename, "size_bytes": size}


def _prune_empty(directory: Path) -> None:
    """Remove the repo directories a deleted file leaves behind.

    Only empty ones, and never the models directory itself. Without this, a
    year of trying quants leaves a tree of empty `<owner>/<repo>` folders that
    look like models that failed to download.
    """
    base = MODELS_DIR.resolve()
    current = directory.resolve()
    while current != base and base in current.parents:
        try:
            current.rmdir()
        except OSError:
            return
        current = current.parent


# The two group names the UI offers carry meaning, and creating either with the
# wrong policy would make the console lie: picking "small" promises the model can
# sit alongside ComfyUI, which only holds if the group is non-exclusive.
_GROUP_POLICIES = {
    "small": {"swap": False, "exclusive": False},
    "large": {"swap": True, "exclusive": True},
}


def _group_policy(group: str) -> dict:
    # Unknown group names fail safe as exclusive: on a 32 GB card, wrongly
    # assuming a model shares the GPU costs an out-of-memory failure, while
    # wrongly assuming it does not costs only an unnecessary unload.
    return dict(_GROUP_POLICIES.get(group, {"swap": True, "exclusive": True}))


def _sync_group_membership(data: Any, model_id: str, group: str | None) -> None:
    """Put the model in exactly one group, creating it if needed.

    Membership is rebuilt rather than appended to, so moving a model between
    groups cannot leave it listed in both — which llama-swap would honour, with
    the stricter group silently winning.
    """
    groups = data.get("groups") or {}
    for spec in groups.values():
        members = spec.get("members") or []
        if model_id in members:
            # Emptied, never removed. An empty group costs llama-swap nothing,
            # while deleting the last one strands the comments above it and
            # renders a config that will not parse.
            spec["members"] = [m for m in members if m != model_id]

    if group is None:
        return

    data.setdefault("groups", {})
    if group not in data["groups"]:
        data["groups"][group] = {**_group_policy(group), "members": []}
    members = data["groups"][group].setdefault("members", [])
    if model_id not in members:
        members.append(model_id)


def list_gguf_files() -> list[dict]:
    """GGUF files on disk, each annotated with the models that reference it.

    `used_by` being empty is what identifies an orphan -- weights left behind
    after their model entry was removed. Those are exactly the files worth
    reclaiming, and there is no other way to spot them from the config alone.
    """
    if not MODELS_DIR.is_dir():
        return []

    try:
        models = _load().get("models") or {}
    except Exception:
        logger.exception("could not read the config while listing files")
        models = {}

    references: dict[str, list[str]] = {}
    for model_id, spec in models.items():
        for filename in _files_in_cmd(spec.get("cmd")):
            references.setdefault(filename, []).append(model_id)

    files = []
    # Recursive since downloads land under `<owner>/<repo>/`. Files sitting
    # loose at the top level are still found -- everything downloaded before
    # this is one, and moving them would break the config entries pointing at
    # them for no gain.
    for path in sorted(MODELS_DIR.rglob("*.gguf")):
        stat = path.stat()
        relative = path.relative_to(MODELS_DIR).as_posix()
        files.append({
            "filename": relative,
            # The repo it came from, or empty for a file that predates the
            # layout or was put there by hand. The interface needs to be able
            # to say which of two identically-named quants this is.
            "repo": str(Path(relative).parent) if "/" in relative else "",
            "size_bytes": stat.st_size,
            "size_gib": round(stat.st_size / 1024**3, 2),
            "modified": stat.st_mtime,
            "is_mmproj": path.name.lower().startswith("mmproj"),
            "used_by": sorted(references.get(relative, [])),
        })
    return files


def list_partials() -> list[dict]:
    """Interrupted downloads. They are resumable, but they also occupy real
    disk, so the UI has to be able to see and discard them."""
    if not MODELS_DIR.is_dir():
        return []
    return [
        {
            "filename": path.relative_to(MODELS_DIR).as_posix(),
            "size_bytes": path.stat().st_size,
            "size_gib": round(path.stat().st_size / 1024**3, 2),
        }
        for path in sorted(MODELS_DIR.rglob("*.part"))
    ]


def delete_partial(filename: str) -> dict:
    if not filename.endswith(".part"):
        return {"ok": False, "reason": "只能刪除 .part 檔"}
    path = _resolve_model_path(filename)
    if path is None:
        return {"ok": False, "reason": "路徑不在模型目錄底下"}
    if not path.is_file():
        return {"ok": False, "reason": "檔案不存在"}
    size = path.stat().st_size
    try:
        path.unlink()
        _prune_empty(path.parent)
    except OSError as exc:
        return {"ok": False, "reason": str(exc)}
    return {"ok": True, "filename": filename, "size_bytes": size}


_ARG_PATTERNS = {
    "model_file": re.compile(r"--model\s+(?:\$\{[^}]+\}/)?(\S+\.gguf)"),
    "mmproj": re.compile(r"--mmproj\s+(?:\$\{[^}]+\}/)?(\S+\.gguf)"),
    "ctx_size": re.compile(r"--ctx-size\s+(\d+)"),
    "n_gpu_layers": re.compile(r"--n-gpu-layers\s+(\d+)"),
}

# Flags the editor owns. Anything else in cmd is the user's own and is handed
# back as free text rather than silently dropped on the next save.
_MANAGED = ("--model", "--mmproj", "--ctx-size", "--n-gpu-layers",
            "--host", "--port", "--jinja")


def read_model_spec(model_id: str) -> dict | None:
    """Parse a model's cmd back into the fields the editor shows.

    Editing has to start from what is actually configured, and the config
    stores a command line rather than a form. Unmanaged flags are preserved
    verbatim in `extra`, so a hand-written option survives a round trip through
    the UI instead of being quietly lost.
    """
    try:
        data = _load()
    except Exception:
        logger.exception("could not read the config while loading a model spec")
        return None

    spec = (data.get("models") or {}).get(model_id)
    if spec is None:
        return None

    cmd = str(spec.get("cmd") or "")
    values = {}
    for field, pattern in _ARG_PATTERNS.items():
        match = pattern.search(cmd)
        values[field] = match.group(1) if match else None

    extra = []
    for line in cmd.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("${") or stripped.startswith("#"):
            continue
        if any(stripped.startswith(flag) for flag in _MANAGED):
            continue
        extra.append(stripped)

    group = next(
        (name for name, g in (data.get("groups") or {}).items()
         if model_id in (g.get("members") or [])),
        None,
    )

    return {
        "id": model_id,
        "name": spec.get("name") or model_id,
        "description": spec.get("description") or "",
        "model_file": values["model_file"] or "",
        "mmproj": values["mmproj"],
        "ctx_size": int(values["ctx_size"]) if values["ctx_size"] else 16384,
        "n_gpu_layers": int(values["n_gpu_layers"]) if values["n_gpu_layers"] else 0,
        "ttl": int(spec.get("ttl") or 0),
        "group": group,
        "extra": "\n".join(extra),
    }
