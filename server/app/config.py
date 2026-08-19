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
import os
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

# The launcher a model is started through, when nothing says otherwise.
#
# This used to be the constant `${llama-sycl}`, which was this machine's
# arrangement written into every model the console creates -- and on a host
# without that macro, every one of them would have been born broken. It is now
# only the last resort, and the callers below prefer, in order: the launcher
# the entry already uses, the one belonging to the card the model is pinned to,
# and the only one this machine has.
FALLBACK_WRAPPER = "${llama-sycl}"

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

    _write(text)


def _write(text: str) -> None:
    """Replace the config atomically, so no reader ever sees half a file."""
    tmp = CONFIG_PATH.with_suffix(".yaml.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(CONFIG_PATH)


# How long llama-swap may take to notice a write and come back with the new
# model list. It watches the file, so this is a debounce plus a parse, not a
# restart.
RELOAD_TIMEOUT = 10.0


# What llama-swap says about a config it has just read. These two lines are the
# only place the outcome appears -- there is no reload endpoint and no status
# field, and /v1/models is no help because a rejected config leaves the previous
# one serving, which for most edits lists exactly the same models.
_RELOADED = "configuration reloaded"
_REJECTED = "failed to reload config"


async def _journal(*args: str) -> str | None:
    try:
        proc = await asyncio.create_subprocess_exec(
            "journalctl", "--user", "-u", "llama-swap.service", "--no-pager", *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except OSError:
        return None
    out, _ = await proc.communicate()
    return out.decode("utf-8", "replace") if proc.returncode == 0 else None


async def _mark() -> str | None:
    """A cursor for the last line llama-swap has logged so far.

    A cursor rather than a timestamp: the journal's `--since` granularity is one
    second, and the second containing the write also contains the reload from
    whatever was saved just before it. Reading from a cursor cannot see a
    verdict that was already there.
    """
    text = await _journal("-n", "1", "-o", "cat", "--show-cursor")
    if not text:
        return None
    for line in reversed(text.splitlines()):
        if line.startswith("-- cursor:"):
            return line.split(":", 1)[1].strip()
    return None


async def _accepted(mark: str | None) -> bool | None:
    """Whether llama-swap took the config written just now.

    None when no verdict arrives: llama-swap is not running, the journal cannot
    be read, or the write changed nothing it cares about. Unknown must not
    block an edit -- the console has to stay usable while the thing it
    configures is down.
    """
    if mark is None:
        return None
    deadline = asyncio.get_running_loop().time() + RELOAD_TIMEOUT
    while asyncio.get_running_loop().time() < deadline:
        text = await _journal("--after-cursor", mark, "-o", "cat")
        if text is None:
            return None
        if _REJECTED in text:
            return False
        if _RELOADED in text:
            return True
        await asyncio.sleep(0.5)
    return None


async def _apply(data: Any) -> None:
    """Write the config, and put it back if llama-swap will not have it.

    The check exists because of how llama-swap answers a config it cannot
    parse: it logs one WARN and *keeps serving the last config it could read*.
    Nothing else surfaces. A file that is valid YAML but the wrong shape --
    `env` written as a mapping where a list of strings belongs -- therefore
    produced a console where every edit appeared to work and none of them did,
    including creating a model, until somebody noticed the list had stopped
    changing.

    Validating the YAML here cannot catch that, because the YAML was fine. Only
    llama-swap knows its own schema, so it is asked.
    """
    previous = CONFIG_PATH.read_text(encoding="utf-8")
    mark = await _mark()
    _dump(data)

    accepted = await _accepted(mark)
    if accepted is None:
        logger.warning("no reload verdict from llama-swap; leaving the config in place")
        return
    if accepted:
        return

    _write(previous)
    logger.error("llama-swap did not accept the new config; rolled back")
    raise ValueError(
        "llama-swap 不接受這份設定，已還原成修改前的內容。"
        "詳細原因在 llama-swap 的日誌裡（設定沒有被套用）。"
    )


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


def launcher_macros() -> dict[str, str]:
    """{macro name: path}, for the macros that name an executable.

    The inverse lookup the device picker needs: a chosen card belongs to a
    launcher, and a model entry has to name that launcher the way llama-swap
    refers to it.
    """
    try:
        data = _load()
    except Exception:
        logger.exception("could not read the config while listing launchers")
        return {}
    out = {}
    for name, value in (data.get("macros") or {}).items():
        path = Path(str(value)).expanduser()
        if path.is_file() and os.access(path, os.X_OK):
            out[str(name)] = str(path)
    return out


def wrapper_for(launcher: str | None) -> str | None:
    """`${macro}` for a launcher path, or None if no macro names it."""
    if not launcher:
        return None
    for name, path in launcher_macros().items():
        if path == launcher:
            return "${%s}" % name
    return None


def default_wrapper() -> str:
    """The launcher to use when nothing has said which.

    A machine with exactly one is not making a choice, so it gets used whatever
    it is called -- which is the case that matters for a host that never had a
    native build. Past that, the historical name, which at least fails loudly
    on a machine that does not have it rather than starting the wrong backend.
    """
    macros = launcher_macros()
    if len(macros) == 1:
        return "${%s}" % next(iter(macros))
    return FALLBACK_WRAPPER


def build_cmd(
    model_file: str,
    ctx_size: int = 16384,
    n_gpu_layers: int = 99,
    extra: str = "",
    mmproj: str | None = None,
    wrapper: str | None = None,
) -> str:
    """Assemble a llama-server command line.

    --n-gpu-layers is written explicitly but defaults to 99 rather than being
    omitted: llama.cpp refuses to auto-fit when the flag is present, so leaving
    it out is the right choice for models that do not fit, and the UI has to be
    able to clear it. Callers pass 0 to mean "let llama.cpp decide".
    """
    lines = [
        wrapper or FALLBACK_WRAPPER,
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
    env: dict | None = None,
    managed_env: set[str] | None = None,
    wrapper: str | None = None,
) -> None:
    async with _lock:
        data = _load()
        models = data.setdefault("models", {})
        # Merged into the existing entry, never substituted for it.
        #
        # llama-swap understands more keys than this form does -- `aliases`,
        # `env`, `filters`, `cmdStop` -- and a hand-written one is not the UI's
        # to delete. Replacing the mapping wholesale silently dropped them on
        # the next edit through the console, which is the worst shape a data
        # loss can take: it happens later, to somebody who changed something
        # unrelated. Mutated in place rather than rebuilt so ruamel keeps the
        # comments attached to the mapping as well.
        entry = models.get(model_id)
        if not isinstance(entry, dict):
            entry = {}
            models[model_id] = entry
        entry["name"] = name
        entry["description"] = description
        # An edit that does not say which launcher keeps the one already there.
        # Silently moving a model from the NVIDIA launcher to the Intel one
        # because the form did not mention it would be a very quiet way to
        # break a card that was working.
        entry["cmd"] = build_cmd(
            model_file, ctx_size, n_gpu_layers, extra, mmproj,
            wrapper or _wrapper_in(entry.get("cmd")) or default_wrapper(),
        )
        entry["ttl"] = ttl

        # Which card this model runs on, as llama-swap's per-model `env`.
        #
        # A list of `NAME=value` strings, which is llama-swap's format and not
        # the mapping YAML would tempt you into: a mapping here fails to
        # unmarshal, and it fails for the *whole file*, so llama-swap keeps
        # running on the last config it could read and every later edit --
        # including a model somebody has just created -- silently does nothing.
        #
        # Only the variables the caller says it manages are cleared. An
        # environment variable somebody added by hand is not the UI's to
        # remove, the same rule the rest of this entry follows.
        managed = managed_env or set()
        kept = [item for item in _env_pairs(entry.get("env"))
                if item.split("=", 1)[0] not in managed]
        added = [f"{name}={value}" for name, value in (env or {}).items()]
        merged = kept + added
        if merged:
            entry["env"] = merged
        else:
            entry.pop("env", None)

        _sync_group_membership(data, model_id, group)
        await _apply(data)
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


def weights() -> dict[str, list[dict]]:
    """Every model's GGUF files, with sizes and who else points at them.

    One pass over the whole config rather than files_for_model called per
    model, because the interesting question is global: sharing is a property of
    the set of entries, not of one of them. A vision projector is the ordinary
    case now -- unsloth ships one mmproj for all fourteen quants of a model, and
    it is BF16 and unquantised, so two entries differing only in quant point at
    the same file by design. Answering that once keeps the answers consistent.

    The role comes from the flag rather than the filename. `mmproj` in a name is
    a convention that holds until somebody renames a file.
    """
    try:
        models = _load().get("models") or {}
    except Exception:
        logger.exception("could not read the config while listing weights")
        return {}

    references: dict[str, list[str]] = {}
    for model_id, spec in models.items():
        for name in _files_in_cmd(spec.get("cmd")):
            references.setdefault(name, []).append(model_id)

    out: dict[str, list[dict]] = {}
    for model_id, spec in models.items():
        cmd = str(spec.get("cmd") or "")
        projectors = {
            _MACRO.sub("", token) for token in _MMPROJ_FILES.findall(cmd)
        }
        entries = []
        for name in sorted(_files_in_cmd(cmd)):
            path = _resolve_model_path(name)
            exists = bool(path and path.is_file())
            entries.append({
                "filename": name,
                "basename": Path(name).name,
                "repo": str(Path(name).parent) if "/" in name else "",
                "role": "mmproj" if name in projectors else "model",
                "exists": exists,
                "size_bytes": path.stat().st_size if exists else 0,
                # Not a warning. Two quants sharing a projector is the design;
                # this is here so deleting one entry does not look like it
                # takes the file with it.
                "shared_with": sorted(
                    other for other in references.get(name, []) if other != model_id
                ),
            })
        # The weights first, then the projector: that is the order they are
        # loaded in and the order the sizes add up in.
        entries.sort(key=lambda e: (e["role"] != "model", e["basename"]))
        out[model_id] = entries
    return out


_MMPROJ_FILES = re.compile(r"--mmproj\s+(\S+\.gguf)")


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
        await _apply(data)

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
        # The resume ledger goes with it. Left behind it describes a file that
        # no longer exists, and the next download believes it.
        path.with_suffix(path.suffix + ".state").unlink(missing_ok=True)
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


# Alias lookups, refreshed when the file changes rather than per request.
_aliases: dict[str, str] = {}
_aliases_stamp: float = -1.0


def canonical_model(name: str) -> str:
    """The config key a request's `model` names, following aliases.

    llama-swap resolves aliases itself, so a request works either way. This is
    for the console's own bookkeeping: it compares the requested name against
    what is running, and an aliased name matches nothing, so an already-loaded
    model looks absent and the VRAM path goes looking for room that is already
    there -- possibly evicting ComfyUI to make it.
    """
    global _aliases, _aliases_stamp
    try:
        stamp = CONFIG_PATH.stat().st_mtime
    except OSError:
        return name
    if stamp != _aliases_stamp:
        try:
            data = _load()
        except Exception:
            logger.exception("could not read the config while resolving aliases")
            return name
        _aliases = {
            str(alias): model_id
            for model_id, spec in (data.get("models") or {}).items()
            for alias in ((spec or {}).get("aliases") or [])
        }
        _aliases_stamp = stamp
    return _aliases.get(name, name)


# The launcher reference at the head of a cmd: `${llama-sycl}`.
_WRAPPER_LINE = re.compile(r"^\s*(\$\{[^}]+\})\s*$", re.M)


def _wrapper_in(cmd: Any) -> str | None:
    match = _WRAPPER_LINE.search(str(cmd or ""))
    return match.group(1) if match else None


def _env_pairs(value: Any) -> list[str]:
    """A model entry's `env`, as the list of strings llama-swap wants.

    Tolerant on the way in because this console wrote the wrong shape once: a
    mapping is accepted and flattened rather than dropped, so a config edited
    by that version repairs itself on the next save instead of losing the
    setting.
    """
    if isinstance(value, dict):
        return [f"{name}={item}" for name, item in value.items()]
    if isinstance(value, (list, tuple)):
        return [str(item) for item in value]
    return []


def env_map(value: Any) -> dict[str, str]:
    """The same thing as a mapping, for comparing against a device's selector."""
    out: dict[str, str] = {}
    for item in _env_pairs(value):
        name, _, text = item.partition("=")
        out[name] = text
    return out


async def add_macro(name: str, value: str) -> None:
    """Name a launcher in the config, so the device probe can find it.

    A macro because that is what the macros in this file already are -- the
    existing `llama-sycl` is one -- and because naming it is the whole of
    registration: nothing else has to be told a new backend exists.
    """
    async with _lock:
        data = _load()
        macros = data.setdefault("macros", {})
        if macros.get(name) == value:
            return
        macros[name] = value
        await _apply(data)
    logger.info("registered launcher macro %s -> %s", name, value)


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
        # As a mapping, so the UI can tell which device entry it corresponds to
        # without either side handling llama-swap's list-of-strings shape.
        "env": env_map(spec.get("env")),
        # Preserved so an edit cannot move a model to another card's launcher
        # just by not mentioning it.
        "wrapper": _wrapper_in(spec.get("cmd")) or "",
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
