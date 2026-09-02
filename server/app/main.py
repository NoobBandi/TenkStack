"""Backend for the local AI console.

Deliberately thin. llama-swap already owns model lifecycle and ComfyUI owns
image generation; this process exists to merge their state with the GPU
telemetry neither of them can produce on Intel hardware, to own the two things
neither of them does at all (downloads, accounts), and to serve it to the UI
over one connection.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import mimetypes
import socket
import time
import tomllib
from pathlib import Path
from typing import AsyncIterator
from urllib.parse import quote

import httpx
from fastapi import Body, Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import (
    activity,
    auth, backends, catalog, channels, chats, comfy, config, containers, files,
    blobs, gguf, gpu, gpu_history, llamaswap, logs as journal, paths, search,
    settings, speed, system, users, versions,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

# ComfyUI instances are discovered, not configured.
#
# Which GPU an instance uses is fixed when it starts: --oneapi-device-selector,
# --cuda-device and --default-device are all launch flags, so a running instance
# cannot be moved to another card. The arrangement that lets two cards work at
# once is therefore one instance per card, each on its own port with its own
# queue -- and choosing a card means choosing which instance to open, not
# setting anything.
#
# Given that, a config file listing the instances would be a second copy of a
# truth the running processes already hold, and would be wrong in both
# directions: an instance listed but not running, or running but not listed. So
# the ports are probed, and each instance self-describes -- /system_stats
# reports the device it was launched against.
COMFYUI_PORTS = tuple(range(8188, 8192))
# Caddy republishes each one behind the console's login: 8188 on 8444, and so on.
COMFYUI_PUBLIC_OFFSET = 8444 - 8188
GPU_POLL_SECONDS = 2.0
WEB_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"

# Read rather than repeated. This was a third copy of the version, and the
# copies had already drifted: pyproject said 0.1.0 while this and the frontend
# said 0.2.0. Each half of the project now states it once, in the file that
# owns it.
def _version() -> str:
    try:
        with (Path(__file__).resolve().parents[1] / "pyproject.toml").open("rb") as f:
            return tomllib.load(f)["project"]["version"]
    except Exception:
        # A version is not worth failing to start over.
        return "0"


app = FastAPI(title="TenkStack", version=_version())

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _startup() -> None:
    users.init()
    settings.init()
    chats.init()
    # Sampling starts with the process, not with the first browser: the chart
    # should show the last hour on load rather than begin at zero.
    gpu_history.start()
    journal.start()
    if not auth.enforcement_enabled():
        logger.warning(
            "no accounts exist yet, so authentication is OFF. It switches on by "
            "itself as soon as the first user is created."
        )


@app.on_event("shutdown")
async def _shutdown() -> None:
    """Let go of the child processes before uvicorn waits on them."""
    await journal.stop()
    await gpu_history.stop()


@app.middleware("http")
async def require_auth(request: Request, call_next):
    """Gate /api and /v1. Static assets and the SPA shell stay open so the login
    page can load at all."""
    path = request.url.path
    guarded = path.startswith("/api/") or path.startswith("/v1/")

    if guarded and path not in auth.PUBLIC_PATHS and auth.enforcement_enabled():
        identity = auth.identify(request)
        if identity is None:
            return JSONResponse({"detail": "authentication required"}, status_code=401)
        request.state.identity = identity
    else:
        request.state.identity = auth.identify(request) if guarded else None

    return await call_next(request)


# --------------------------------------------------------------------------
# Authentication
# --------------------------------------------------------------------------

@app.post("/api/auth/login")
async def login(response: Response, payload: dict = Body(...)):
    user = users.verify_password(payload.get("username", ""), payload.get("password", ""))
    if user is None:
        raise HTTPException(status_code=401, detail="帳號或密碼錯誤")
    response.set_cookie(
        auth.COOKIE_NAME,
        auth.issue_session(user),
        max_age=auth.SESSION_TTL,
        httponly=True,
        samesite="lax",
        # Not `secure`: this is served over plain HTTP on the LAN today. It
        # becomes secure once Caddy terminates TLS in front.
    )
    return user


@app.post("/api/auth/logout")
async def logout(response: Response):
    response.delete_cookie(auth.COOKIE_NAME)
    return {"ok": True}


@app.get("/api/auth/me")
async def whoami(request: Request):
    return {
        "identity": getattr(request.state, "identity", None),
        "enforcement": auth.enforcement_enabled(),
    }


# --------------------------------------------------------------------------
# GPU
# --------------------------------------------------------------------------

@app.get("/api/logs")
async def read_logs(limit: int = 400):
    """Recent lines from every service, oldest first."""
    return {"lines": journal.history(limit), "units": journal.UNITS}


@app.get("/api/gpu")
async def read_gpu():
    """Live counters for every installed GPU, lowest index first."""
    samples = gpu_history.latest_all()
    if not samples:
        # Before the poller's first tick, ask directly rather than answering
        # with an empty list that the UI would read as "no GPU".
        one = await gpu.sample_dict(0)
        samples = [one] if one else []
    return samples or {"error": "xpu-smi unavailable"}


@app.get("/api/gpu/history")
async def read_gpu_history(seconds: int = 900, points: int = 600):
    """Samples collected since the backend started, thinned for drawing.

    Keyed by device index. JSON object keys are strings, which the client has
    to parse back -- the alternative, a list positioned by index, breaks the
    moment indices are not contiguous.
    """
    series = gpu_history.history_all(seconds, points)
    return {
        "interval": gpu_history.SAMPLE_INTERVAL,
        "devices": {str(i): pts for i, pts in series.items()},
    }


@app.get("/api/gpu/devices")
async def read_gpu_devices():
    """Every GPU with its full inventory and live counters."""
    return await gpu.list_devices()


@app.get("/api/versions")
async def read_versions():
    """Installed versions of every moving part, each probed independently."""
    return await versions.collect()


@app.get("/api/system")
async def read_system():
    """Host CPU, memory and disk. The GPU is only half the picture: a model
    that spills into RAM, or a download with nowhere to land, shows up here
    and nowhere else."""
    return system.sample()


# --------------------------------------------------------------------------
# Models
# --------------------------------------------------------------------------

class ModelSpec(BaseModel):
    id: str = Field(min_length=1)
    name: str = ""
    description: str = ""
    model_file: str
    ctx_size: int = 16384
    n_gpu_layers: int = 99
    ttl: int = 900
    group: str | None = "large"
    extra: str = ""
    mmproj: str | None = None
    # Which cards to run on, as `backend:index` -- `SYCL:0`, `CUDA:1` -- either
    # one or a list of them. A list is how a model gets both cards, which is
    # what --split-mode has to have to do anything at all.
    #
    # Three states, and they are not the same. `null` (or absent) means the
    # caller did not mention a card, so whatever the entry already says is left
    # alone -- an edit that does not name a card must not unpin one. `""` (or
    # `[]`) means the caller cleared it, which is what the form sends when its
    # select is emptied. A value pins.
    device: str | list[str] | None = None


@app.get("/api/models")
async def read_models():
    """Configured models joined with which of them are currently resident."""
    models, running = await asyncio.gather(llamaswap.list_models(), llamaswap.get_running())
    by_id = {r["model"]: r for r in running}
    contexts = config.context_sizes()
    declared = config.declared_vision()

    # Ask each running model what it actually loaded. Only running models can
    # answer, so stopped ones fall back to what their command line declares.
    proxies = {mid: entry.get("proxy") for mid, entry in by_id.items() if entry.get("proxy")}
    props_list, slots_list = await asyncio.gather(
        asyncio.gather(*(llamaswap.get_props(p) for p in proxies.values())),
        # Asked alongside props rather than from a route of its own: both are
        # per-running-model reads of the same server, and a second endpoint
        # would mean a second poll to keep in step with this one.
        asyncio.gather(*(llamaswap.get_slots(p) for p in proxies.values())),
    )
    props = dict(zip(proxies.keys(), props_list))
    slots = dict(zip(proxies.keys(), slots_list))

    sampling = config.sampling_defaults()
    weights = config.weights()

    result = []
    for m in models:
        model_id = m["id"]
        live = props.get(model_id)
        modalities = (live or {}).get("modalities") or {}
        result.append({
            **m,
            "running": model_id in by_id,
            "state": by_id.get(model_id, {}).get("state", "stopped"),
            "proxy": by_id.get(model_id, {}).get("proxy"),
            "ttl": by_id.get(model_id, {}).get("ttl"),
            "ctx_size": contexts.get(model_id),
            # What this model was configured to be sampled with. The panel seeds
            # itself from this so the config and the interface cannot disagree.
            "sampling": sampling.get(model_id) or None,
            # Which files this entry is made of. Two entries differing only in
            # quantisation are otherwise indistinguishable in a list -- same
            # name, same everything -- and they compete for the same card, so
            # the sizes belong next to them.
            "weights": weights.get(model_id, []),
            # How full each slot is now. None for a model that is not running,
            # and for one whose server was started with --no-slots -- neither
            # is the same as empty, so the UI says nothing rather than zero.
            "slots": slots.get(model_id),
            "capabilities": {
                "vision": bool(modalities.get("vision")) if live else declared.get(model_id, False),
                "audio": bool(modalities.get("audio")) if live else False,
                # Tool calling needs a chat template that defines it; llama-server
                # only reports one when --jinja is in effect.
                "tools": bool((live or {}).get("chat_template")) if live else False,
                # Says whether the flags above were measured or merely declared,
                # so the UI can avoid promising a capability it has not seen.
                "source": "live" if live else "config",
            },
        })
    return result


async def _device_env(chosen: str | list[str] | None) -> dict | None:
    """The environment one or more `backend:index` choices mean.

    Resolved against what llama-server actually enumerates rather than
    constructed from the string, so a stale choice -- a card that has since
    been removed -- writes no selector at all instead of one pointing at a
    device that is not there.

    Several cards compose into one selector rather than several: both vendors
    express the choice as a single variable holding a list, so the indices are
    joined and put through the same template. `level_zero:0,1`, `0,1`.

    Returns `{}` for "no card asked for" and `None` for "a card was asked for
    and could not be resolved". They have to be distinguishable: the caller
    clears the stored selector for the first and must leave it alone for the
    second, or an edit made through a form that could not display the current
    value would silently delete it.
    """
    wanted = [chosen] if isinstance(chosen, str) else list(chosen or [])
    wanted = [item for item in wanted if item]
    if not wanted:
        return {}

    devices = await backends.usable()
    by_backend: dict[str, list[str]] = {}
    for item in wanted:
        backend, _, index = item.partition(":")
        hit = next((d for d in devices
                    if d["backend"] == backend and str(d["index"]) == index), None)
        if hit is None:
            logger.warning("model asked for device %s, which no launcher sees", item)
            return None
        by_backend.setdefault(backend, []).append(index)

    if len(by_backend) > 1:
        # One llama-server process, one backend. Splitting a model across an
        # Intel card and an NVIDIA one is not something the launcher can do.
        logger.warning("model asked for devices across backends: %s", wanted)
        return None

    selectors = backends.selector_templates()
    backend, indices = next(iter(by_backend.items()))
    template = selectors.get(backend.upper())
    if template is None:
        return None
    variable, pattern = template
    return {variable: pattern.format(",".join(indices))}


async def _device_wrapper(chosen: str | list[str] | None) -> str | None:
    """The launcher macro for the chosen cards, or None to leave it alone.

    None is not a default -- it means the caller did not name a card, and an
    edit that does not name one must keep the launcher the entry already has.
    Choosing for it would move a working model to another vendor's backend
    because a form field was left empty.

    Several cards resolve to one launcher, because one llama-server process
    runs on one backend; the first is enough, and _device_env has already
    refused a selection that spans two.
    """
    wanted = [chosen] if isinstance(chosen, str) else list(chosen or [])
    wanted = [item for item in wanted if item]
    if not wanted:
        return None
    backend, _, index = wanted[0].partition(":")
    for device in await backends.usable():
        if device["backend"] == backend and str(device["index"]) == index:
            return config.wrapper_for(device.get("launcher"))
    return None


@app.get("/api/backends/devices")
async def read_backend_devices(refresh: bool = False):
    """The cards a configured llama-server can actually see.

    Not the GPU list: a card with no runtime that can drive it cannot run a
    model, and offering it would be a choice that fails at load time.
    """
    devices, cards = await asyncio.gather(backends.usable(refresh), gpu.list_devices())
    return backends.match(devices, cards)


@app.get("/api/blobs/{digest}")
async def read_blob(digest: str):
    """One stored image.

    Cached for a year without revalidation, which is safe in the one case where
    it always is: the name is the SHA-256 of the contents, so a given URL can
    never answer with something else.
    """
    found = blobs.resolve(f"blob:{digest}")
    if found is None:
        raise HTTPException(status_code=404, detail="沒有這個檔案")
    path, media = found
    return FileResponse(path, media_type=media, headers={
        "cache-control": "public, max-age=31536000, immutable",
    })


@app.get("/api/runtimes")
async def read_runtimes():
    """Every card in the machine, and what each one is currently for."""
    cards = await gpu.list_devices()
    rows = await backends.coverage(cards)
    for row, card in zip(rows, cards):
        row["comfy"] = await comfy.state(card, cards, row["containers"])
    return rows


@app.post("/api/runtimes/card")
async def set_card_role(payload: dict = Body(...),
                        _: dict = Depends(auth.require_owner)):
    """Turn one of a card's two jobs on or off.

    The two are not symmetrical underneath, and pretending otherwise would make
    the failures confusing. Images are a container: switching them off stops
    it, and on starts it, immediately and reversibly. Models are a launcher,
    which belongs to a backend rather than to a card -- so switching them on
    may mean a multi-gigabyte pull the first time, and on a machine with two
    cards of one vendor the switch moves both. The row says so before it is
    touched.
    """
    address = str(payload.get("pci_bdf_address") or "")
    capability = str(payload.get("capability") or "")
    on = bool(payload.get("on"))

    cards = await gpu.list_devices()
    card = next((c for c in cards
                 if c.get("pci_bdf_address")
                 and containers.bus_key(c["pci_bdf_address"]) == containers.bus_key(address)),
                None)
    if card is None:
        raise HTTPException(status_code=404, detail="沒有這張卡")

    if capability == "images":
        held = (await containers.by_card(cards)).get(containers.bus_key(address), [])
        if not held:
            # Nothing on this card yet, so switching it on is the install --
            # the same shape as the model side, where the first On is a pull.
            if not on:
                raise HTTPException(status_code=400, detail="這張卡上沒有 ComfyUI 容器")
            try:
                # Started, not awaited. The image is 16 to 20 GB and the reply
                # has to come back now so the page can show a bar rather than a
                # button that spins for several minutes.
                return {"ok": True, "job": await comfy.start(card, cards, "create")}
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        for box in held:
            await containers.control(box["name"], "start" if on else "stop")
        return {"ok": True}

    if capability == "llm":
        vendor = card.get("vendor") or ""
        try:
            state = await backends.state(vendor) if backends.runtime_for(vendor) else None
            if on and state and not state["managed"]:
                # Nothing installed for this vendor yet, so turning the switch
                # on is the install. The variant stays the caller's choice.
                return await backends.install(vendor, str(payload.get("variant") or "vendor"))
            await backends.enable(vendor, on)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"ok": True}

    raise HTTPException(status_code=400, detail=f"不認識的項目：{capability}")


@app.post("/api/runtimes/comfy")
async def comfy_action(payload: dict = Body(...),
                       _: dict = Depends(auth.require_owner)):
    """Update or remove the ComfyUI instance on one card.

    Separate from the model side's endpoint because they are separate images
    on the same row -- the RTX card here runs models from a 7 GB llama.cpp
    image and draws with a 16 GB ComfyUI one -- and one endpoint taking a
    vendor could not say which of the two it meant.
    """
    name = str(payload.get("name") or "")
    action = str(payload.get("action") or "")
    try:
        if action == "remove":
            await comfy.destroy(name, bool(payload.get("delete_image")))
        elif action == "update":
            # Pull then recreate, because the container names a tag and a new
            # image is only picked up by a new container -- and in the
            # background, because pulling one is minutes.
            cards = await gpu.list_devices()
            held = await containers.by_card(cards)
            card = next((c for c in cards
                         if any(b["name"] == name
                                for b in held.get(containers.bus_key(c["pci_bdf_address"]), []))),
                        None)
            if card is None:
                raise ValueError(f"{name} 沒有對應到任何一張卡")
            return {"ok": True, "job": await comfy.start(card, cards, "update", name)}
        else:
            raise ValueError(f"不認識的動作：{action}")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True}


@app.post("/api/runtimes/action")
async def runtime_action(payload: dict = Body(...),
                         _: dict = Depends(auth.require_owner)):
    """Add, update, switch off or remove a runtime.

    Owner-only and in a browser: these write an executable, edit the file that
    decides how every model starts, and pull or delete several gigabytes. None
    of that belongs to an API key pasted into a chat client.

    Drivers are not here and will not be. Installing one needs root, sometimes
    a reboot, and belongs to whatever installed the kernel module; a web
    console that could do it would be a web console that could brick the
    machine it is served from. Versions are reported instead -- see the
    settings page -- so the mismatch is visible even though the fix is not a
    button.
    """
    vendor = str(payload.get("vendor") or "")
    action = str(payload.get("action") or "")
    try:
        if action == "install":
            return await backends.install(vendor, str(payload.get("variant") or "vendor"))
        if action == "update":
            return await backends.update(vendor)
        if action in {"enable", "disable"}:
            await backends.enable(vendor, action == "enable")
        elif action == "remove":
            await backends.remove(vendor, bool(payload.get("delete_image")))
        else:
            raise ValueError(f"不認識的動作：{action}")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True}


@app.post("/api/models")
async def create_model(spec: ModelSpec):
    """Write a model entry, or say why it could not be written.

    A rejected config is reported as a 400 rather than a 500: the config was
    written and taken back, nothing is broken, and the caller needs the reason
    rather than a stack trace. See `config._apply` for why llama-swap has to be
    asked at all.
    """
    try:
        return await _write_model(spec)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


async def _write_model(spec: ModelSpec):
    device_env = await _device_env(spec.device)
    await config.upsert_model(
        spec.id,
        name=spec.name or spec.id,
        description=spec.description,
        model_file=spec.model_file,
        ctx_size=spec.ctx_size,
        n_gpu_layers=spec.n_gpu_layers,
        ttl=spec.ttl,
        group=spec.group,
        extra=spec.extra,
        mmproj=spec.mmproj,
        env=device_env or {},
        # Only when the caller said something about the card, and only when
        # what it said resolved. An unresolvable choice used to clear the
        # selector: the form sends "" for a select it could not populate, and a
        # multi-card selector was exactly the value it could not populate, so
        # editing a two-card model through the UI silently dropped it back to
        # one card -- without an error, and without the entry saying so.
        managed_env=(backends.selector_vars()
                     if spec.device is not None and device_env is not None
                     else None),
        wrapper=await _device_wrapper(spec.device),
    )
    return {"ok": True, "id": spec.id}


@app.get("/api/models/{model_id}/spec")
async def read_model_spec(model_id: str):
    """The current settings, in the shape the editor expects."""
    spec = config.read_model_spec(model_id)
    if spec is None:
        raise HTTPException(status_code=404, detail="no such model")
    return spec


@app.post("/api/models/{model_id}/unload")
async def unload_one(model_id: str):
    return {"ok": await llamaswap.unload_model(model_id)}


@app.get("/api/models/{model_id}/files")
async def model_files(model_id: str):
    """What deleting this model would remove from disk, before deciding to."""
    return config.files_for_model(model_id)


@app.delete("/api/models/{model_id}")
async def remove_model(model_id: str, delete_files: bool = False):
    try:
        result = await config.delete_model(model_id, delete_files=delete_files)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if result is None:
        raise HTTPException(status_code=404, detail="no such model")
    return {"ok": True, **result}


# Ahead of the catch-all below, and both of them matching a path rather than a
# name. A weight lives at `<owner>/<repo>/<file>` now, so what arrives here has
# slashes in it -- and a single-segment parameter simply did not match, which
# the SPA route then reported as a 405 because it matches every path there is
# and only answers GET. Order matters once these accept slashes: the general
# one would otherwise claim `partials/...` first.
@app.get("/api/files/partials")
async def read_partials():
    return config.list_partials()


@app.delete("/api/files/partials/{filename:path}")
async def remove_partial(filename: str):
    result = config.delete_partial(filename)
    if not result["ok"]:
        raise HTTPException(status_code=409, detail=result["reason"])
    return result


@app.delete("/api/files/{filename:path}")
async def remove_file(filename: str):
    result = config.delete_file(filename)
    if not result["ok"]:
        raise HTTPException(status_code=409, detail=result["reason"])
    return result


@app.post("/api/models/unload")
async def unload_models():
    return {"ok": await llamaswap.unload_all()}


@app.post("/api/models/{model_id}/load")
async def load_model(model_id: str):
    """Force a model resident by sending it a trivial request.

    llama-swap has no explicit load endpoint -- loading is a side effect of
    routing a request -- so this is the supported way to warm a model up.
    """
    await make_room_for(model_id)
    async with httpx.AsyncClient(base_url=llamaswap.BASE_URL, timeout=900) as client:
        try:
            resp = await client.post(
                "/v1/chat/completions",
                json={
                    "model": model_id,
                    "messages": [{"role": "user", "content": "hi"}],
                    "max_tokens": 1,
                },
            )
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": resp.status_code == 200, "status": resp.status_code}


@app.get("/api/models/files")
async def read_model_files():
    return config.list_gguf_files()


@app.get("/api/config")
async def read_config():
    return {"raw": config.raw(), **config.read()}


@app.put("/api/config")
async def write_config(payload: dict = Body(...)):
    text = payload.get("raw")
    if not isinstance(text, str):
        raise HTTPException(status_code=400, detail="'raw' must be a string")
    try:
        await config.write_raw(text)
    except ValueError as exc:
        # Already a sentence about what went wrong -- llama-swap refused it, and
        # it has been rolled back. Prefixing "invalid YAML" would be a second,
        # wrong diagnosis on top of the right one.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"YAML 無法解析：{exc}") from exc
    return {"ok": True}


# --------------------------------------------------------------------------
# The console's own settings, and the machine it is installed on
# --------------------------------------------------------------------------

# Where this install lives, read from `paths` rather than written out again.
#
# The settings page used to list these as literal strings -- `~/ai/models` and
# so on -- which was true of exactly one machine. Every one of them is an
# environment variable with a default, so the variable is named beside the
# resolved value: this is the only place in the console that answers "where
# does this install actually live", and it has to answer for the reader's
# machine rather than for the author's.
_PATHS = [
    ("CONSOLE_AI_DIR", "根目錄", lambda: paths.AI_DIR),
    ("CONSOLE_MODELS_DIR", "模型權重", lambda: paths.MODELS_DIR),
    ("CONSOLE_LLAMA_SWAP_CONFIG", "llama-swap 設定", lambda: paths.LLAMA_SWAP_CONFIG),
    ("CONSOLE_CADDY_DIR", "Caddy 設定", lambda: paths.CADDY_DIR),
    ("CONSOLE_COMFYUI_DIR", "ComfyUI 儲存", lambda: paths.COMFY_DIR),
    ("CONSOLE_STATE_DIR", "主控台資料", lambda: paths.STATE_DIR),
]

# The user units this console shares a machine with. Containers are not here --
# the runtime page reads those from Docker, and listing them twice is how two
# lists start disagreeing.
_UNITS = [
    ("llama-swap.service", "模型生命週期，OpenAI／Anthropic 端點"),
    ("caddy.service", "TLS 與單一入口"),
    ("ai-console.service", "本服務"),
]


@app.get("/api/machine")
async def read_machine():
    """Where this install lives and which of its units are running."""
    async def unit(name: str) -> dict:
        """One unit's state, asked of systemd rather than assumed.

        `show` rather than `is-active`: it answers for a unit that does not
        exist too, which is the case on a machine that runs one of these some
        other way.
        """
        try:
            proc = await asyncio.create_subprocess_exec(
                "systemctl", "--user", "show", name,
                "-p", "ActiveState", "-p", "SubState", "-p", "ExecMainStartTimestamp",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
            out, _ = await proc.communicate()
        except OSError:
            return {"name": name, "active": "unknown", "sub": "", "since": ""}
        fields = dict(
            line.split("=", 1) for line in out.decode().splitlines() if "=" in line
        )
        return {
            "name": name,
            "active": fields.get("ActiveState") or "unknown",
            "sub": fields.get("SubState") or "",
            "since": fields.get("ExecMainStartTimestamp") or "",
        }

    units = []
    for name, note in _UNITS:
        state = await unit(name)
        units.append({**state, "note": note})

    return {
        "paths": [
            {"variable": variable, "label": label, "path": str(resolve()),
             "exists": resolve().exists()}
            for variable, label, resolve in _PATHS
        ],
        "units": units,
    }


@app.get("/api/settings")
async def read_settings():
    return settings.describe()


@app.put("/api/settings")
async def write_settings(payload: dict = Body(...),
                         _: dict = Depends(auth.require_owner)):
    """Change the console's own knobs.

    Owner-only: these decide whether a chat request may evict somebody's image
    generation, and how many steps an agent may spend.
    """
    try:
        values = settings.save(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # Two of them own a buffer that already exists, so they are applied rather
    # than waited for.
    journal.set_capacity(values["log_lines"])
    gpu_history.set_hours(values["gpu_history_hours"])
    return settings.describe()


# --------------------------------------------------------------------------
# Runtime containers
# --------------------------------------------------------------------------

@app.get("/api/activity")
async def read_activity(limit: int = 400, model: str | None = None):
    """Completed requests with their depth and their rate.

    Read straight out of llama-swap's store on each call rather than cached:
    the file is small, the query is indexed by rowid, and a cache here would
    only ever be a stale copy of a table another process owns.
    """
    return activity.recent(limit=max(1, min(limit, 2000)), model_id=model)


@app.get("/api/models/last-used")
async def read_last_used():
    """The model id of the most recent request, for pages that must name one.

    The connections page hands out config files that name a model, and naming
    whichever entry sorts first was wrong in both directions: not the model the
    reader is using, and liable to change when the config is reordered. It asks
    for the running model first and falls back to this when the box is cold.
    """
    return {"model": activity.last_used()}


@app.get("/api/runtime")
async def read_runtime():
    """Every container on this machine, paired with the cards it holds."""
    return await containers.survey(await gpu.list_devices())


@app.post("/api/runtime/container")
async def runtime_container(payload: dict = Body(...),
                            _: dict = Depends(auth.require_owner)):
    """Restart one container.

    Owner-only, and in a browser, for the same reason the filesystem routes are:
    an API key is minted to be pasted into somebody's chat client, and nothing
    about that intent implies the right to bounce the image generator. Restart
    is also the far end of what this console will do to a container -- there is
    no create, no exec, no remove -- because those are indistinguishable from a
    root shell when the process runs in the `docker` group.
    """
    name = str(payload.get("name") or "")
    verb = str(payload.get("verb") or "restart")
    if not await containers.control(name, verb):
        raise HTTPException(status_code=404, detail=f"無法對 {name} 執行 {verb}")
    return {"ok": True}


# --------------------------------------------------------------------------
# Catalog
# --------------------------------------------------------------------------

@app.get("/api/catalog/search")
async def catalog_search(q: str, limit: int = 100):
    return await catalog.search(q, limit)


@app.get("/api/catalog/files")
async def catalog_files(repo_id: str):
    return await catalog.list_files(repo_id)


@app.post("/api/catalog/estimate")
async def catalog_estimate(payload: dict = Body(...)):
    """How fast one GGUF would generate here, read from its header.

    A POST rather than a GET because the parts of a split model are a list, and
    a 40 GiB model split six ways would otherwise have to be flattened into a
    query string. Nothing is written; the cost is one ranged read per file, and
    only the first time.
    """
    repo_id = payload.get("repo_id")
    parts = payload.get("parts") or []
    if not repo_id or not parts:
        raise HTTPException(status_code=400, detail="repo_id and parts are required")
    head = await gguf.describe(repo_id, [str(p) for p in parts])
    if head is None:
        raise HTTPException(status_code=502, detail="could not read the GGUF header")
    estimate = speed.estimate(head, int(payload.get("size_bytes") or 0))
    return {
        "estimate": estimate,
        "architecture": head["architecture"],
        "layers": head["layers"],
        "attention_layers": head["attention_layers"],
        "expert_count": head["expert_count"],
        "expert_used_count": head["expert_used_count"],
        "context_length": head["context_length"],
        "mtp": head["mtp"],
        "by_type": head["by_type"],
    }


@app.post("/api/catalog/download")
async def catalog_download(payload: dict = Body(...)):
    repo_id, filename = payload.get("repo_id"), payload.get("filename")
    if not repo_id or not filename:
        raise HTTPException(status_code=400, detail="repo_id and filename are required")
    return catalog.start(repo_id, filename)


@app.post("/api/catalog/cancel")
async def catalog_cancel(payload: dict = Body(...)):
    return {"ok": catalog.cancel(payload.get("repo_id", ""), payload.get("filename", ""))}


@app.get("/api/catalog/downloads")
async def catalog_downloads():
    return catalog.status()


# --------------------------------------------------------------------------
# ComfyUI
# --------------------------------------------------------------------------

def _comfyui_base(port: int) -> str:
    """Loopback base URL for one instance.

    The port is checked against the discovery range rather than trusted: the
    three endpoints below fetch on the caller's behalf, and an unchecked port
    would turn the console into a relay to everything else listening on this
    machine -- llama-swap and its own API included.
    """
    if port not in COMFYUI_PORTS:
        raise HTTPException(status_code=400, detail="not a ComfyUI port")
    return f"http://127.0.0.1:{port}"


# Ports that answered 404 for ComfyUI-Manager, and when to ask them again.
# Emptied when a container is recreated, since the survey keys on the port and a
# new container on that port is a new image.
_manager_absent: dict[int, float] = {}

# Long enough that a permanently Manager-less instance costs nothing, short
# enough that installing Manager into a running one is noticed without a
# restart.
MANAGER_RECHECK = 600.0

# The last good answer from each port.
#
# ComfyUI is aiohttp with a synchronous torch underneath, so while a sampling
# step runs nothing is served -- the event loop is simply not reached. Probes
# during a video generation therefore time out, and treating that as "no
# instance" made the dashboard blink to "ComfyUI 未執行" and back every few
# seconds during exactly the job someone is watching. A timeout means busy, not
# gone; the last known record is reported instead, flagged stale.
_comfyui_seen: dict[int, dict] = {}

# Short connect, long read. Three of the four ports have nothing on them and
# must be dismissed instantly, while the one that answers may be mid-step.
_COMFYUI_PROBE_TIMEOUT = httpx.Timeout(connect=0.5, read=10.0, write=5.0, pool=5.0)


async def _probe_comfyui(port: int) -> dict | None:
    """One instance, or None if nothing there answers as ComfyUI.

    Absence is returned rather than raised: a port with nothing on it is the
    normal case for three of the four probed, not an error to report.
    """
    async with httpx.AsyncClient(
        base_url=f"http://127.0.0.1:{port}", timeout=_COMFYUI_PROBE_TIMEOUT,
    ) as client:
        try:
            stats, queue = await asyncio.gather(
                client.get("/system_stats"), client.get("/queue")
            )
            stats.raise_for_status()
            queue.raise_for_status()
        except httpx.ConnectError:
            # Refused, so there is genuinely nothing listening. This is the one
            # failure that means the instance is gone.
            _comfyui_seen.pop(port, None)
            return None
        except httpx.HTTPError:
            # Timed out or dropped mid-answer: busy, not absent.
            stale = _comfyui_seen.get(port)
            return {**stale, "stale": True} if stale else None

        # ComfyUI-Manager is a custom node, so its absence is an ordinary state
        # rather than a failure: an instance without it simply has no update
        # controls. Asked on every poll instead of only while an update is
        # running, so progress survives a page reload and shows up even when
        # the update was started from ComfyUI's own interface.
        #
        # Except on an instance that has already said it does not have it. A
        # 404 here is a fact about the image -- the slim ComfyUI build ships no
        # custom nodes at all -- and it does not change while that container
        # runs, so asking every five seconds produced a thousand requests and a
        # thousand log lines a day for an answer nobody was waiting for. Rechecked
        # occasionally rather than never, because somebody can install Manager
        # into a running instance and should not have to restart anything.
        manager = (_comfyui_seen.get(port) or {}).get("manager")
        if _manager_absent.get(port, 0) > time.monotonic():
            pass
        else:
            try:
                mgr = await client.get("/api/manager/queue/status")
                if mgr.status_code == 404:
                    _manager_absent[port] = time.monotonic() + MANAGER_RECHECK
                    manager = None
                else:
                    mgr.raise_for_status()
                    m = mgr.json()
                    _manager_absent.pop(port, None)
                    manager = {
                        "processing": bool(m.get("is_processing")),
                        "done": m.get("done_count") or 0,
                        "total": m.get("total_count") or 0,
                    }
            except (httpx.HTTPError, ValueError):
                # A busy instance should not lose its update controls, so the
                # last known queue state stands in.
                pass

    s, q = stats.json(), queue.json()
    system = s.get("system") or {}
    devices = s.get("devices") or []
    public = port + COMFYUI_PUBLIC_OFFSET
    record = {
        "port": port,
        # A second instance needs its own Caddy site block, and until it has
        # one there is no authenticated way in. Saying so beats handing out a
        # link that cannot connect.
        "public_port": public if _port_open(public) else None,
        "version": system.get("comfyui_version"),
        "python": (system.get("python_version") or "").split()[0],
        "torch": system.get("pytorch_version"),
        # The card this instance holds, which is also the VRAM policy: a card
        # running ComfyUI is a card an LLM has to fit alongside.
        "device": devices[0] if devices else None,
        "queue_running": len(q.get("queue_running") or []),
        "queue_pending": len(q.get("queue_pending") or []),
        "manager": manager,
        "stale": False,
    }
    _comfyui_seen[port] = record
    return record


@app.get("/api/comfyui/instances")
async def read_comfyui_instances():
    """Every ComfyUI on this machine, in port order."""
    found = await asyncio.gather(*(_probe_comfyui(p) for p in COMFYUI_PORTS))
    return [i for i in found if i is not None]


# Which catalogue of known nodes Manager consults: 'remote', 'local' or 'cache'.
#
# 'local' rather than the 'cache' its own interface defaults to, because on this
# install the other two cannot work. They send Manager to the channel URL from
# its config, which it then checks against `valid_channels` -- a set populated
# lazily by get_channel_dict(), which normalize_channel() skips entirely for a
# channel that is already an https:// URL. The configured default is such a URL,
# so the set never gains it and the call fails with InvalidChannel. 'local'
# resolves to the channel named 'local', which is in that set from the start,
# and reads the catalogue that ships with Manager instead of fetching one.
#
# Little is given up: the catalogue is for discovering nodes that are not
# installed, and neither call below installs anything. Whether the installed
# trees are behind is settled by the git fetch against each of them, which runs
# the same way under every mode.
MANAGER_MODE = "local"

# Updating ComfyUI is two independent tracks, and only one of them is here.
#
# The image carries PyTorch, oneAPI and Python, and is replaced by pulling a new
# one and re-running run-comfyui.sh. It cannot be done from a process running
# inside the container it would be replacing, so it stays a shell operation.
#
# ComfyUI itself and its custom nodes are git checkouts in the instance's own
# storage, unaffected by an image change -- the entrypoint only seeds them when
# main.py is absent. That track is what these endpoints drive, through
# ComfyUI-Manager, which is already the thing that knows how to update a tree it
# installed. The console adds one thing Manager cannot: doing it to every
# instance at once, which is what keeps this track cheap as cards are added.


@app.post("/api/comfyui/update/check")
async def comfyui_update_check(port: int = COMFYUI_PORTS[0]):
    """Whether anything is out of date, without changing anything.

    Slow -- it is a git fetch against every installed node, forty of them here,
    each a network round trip. Measured at just under three minutes on this
    machine, hence the timeout: it is sized to a slow run, not a typical one,
    because giving up early would report "unreachable" for a call that was
    working. Worth the wait because the alternative is updating blind.
    """
    async with httpx.AsyncClient(base_url=_comfyui_base(port), timeout=600) as client:
        try:
            resp = await client.post(
                "/api/customnode/fetch_updates", json={"mode": MANAGER_MODE})
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=502, detail=f"manager returned {resp.status_code}")
    # 201 is Manager's way of saying "something moved"; 200 means up to date.
    return {"available": resp.status_code == 201}


@app.post("/api/comfyui/update")
async def comfyui_update(port: int = COMFYUI_PORTS[0], core: bool = True, nodes: bool = True):
    """Queue an update and start the worker.

    Core and nodes go together by default: updating one without the other is
    the most common way to break a ComfyUI, because nodes track the core API.
    """
    async with httpx.AsyncClient(base_url=_comfyui_base(port), timeout=300) as client:
        try:
            # Core first, then nodes, matching the order Manager's own interface
            # queues them in.
            if core:
                resp = await client.post("/api/manager/queue/update_comfyui", json={})
                resp.raise_for_status()
            if nodes:
                # Manager saves a snapshot before queueing these, which is the
                # rollback point if an update goes wrong.
                resp = await client.post(
                    "/api/manager/queue/update_all", json={"mode": MANAGER_MODE})
                if resp.status_code == 401:
                    raise HTTPException(status_code=409, detail="更新已在進行中")
                if resp.status_code == 403:
                    raise HTTPException(
                        status_code=403,
                        detail="ComfyUI-Manager 的 security_level 不允許更新",
                    )
                resp.raise_for_status()
            # 201 means a worker was already running, which is not an error --
            # whatever was just queued will be picked up by it.
            resp = await client.post("/api/manager/queue/start", json={})
            if resp.status_code not in (200, 201):
                resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True}


@app.post("/api/comfyui/restart")
async def comfyui_restart(port: int = COMFYUI_PORTS[0]):
    """Restart ComfyUI so an update takes effect.

    Manager restarts by execv'ing over its own process, so the reply is never
    written -- the connection dies mid-response. A dropped connection here is
    the success case, not a failure to report.
    """
    async with httpx.AsyncClient(base_url=_comfyui_base(port), timeout=10) as client:
        try:
            await client.post("/api/manager/reboot", json={})
        except httpx.HTTPError:
            pass
    return {"ok": True}


@app.get("/api/comfyui/history")
async def comfyui_history(port: int = COMFYUI_PORTS[0], limit: int = 12):
    async with httpx.AsyncClient(base_url=_comfyui_base(port), timeout=5) as client:
        try:
            resp = await client.get("/history", params={"max_items": limit})
            resp.raise_for_status()
        except httpx.HTTPError:
            return []

    items = []
    for prompt_id, record in list(resp.json().items())[-limit:]:
        images = [
            img
            for output in (record.get("outputs") or {}).values()
            for img in (output.get("images") or [])
        ]
        items.append({
            "prompt_id": prompt_id,
            "images": images,
            "status": (record.get("status") or {}).get("status_str"),
        })
    return list(reversed(items))


@app.post("/api/comfyui/interrupt")
async def comfyui_interrupt(port: int = COMFYUI_PORTS[0]):
    async with httpx.AsyncClient(base_url=_comfyui_base(port), timeout=5) as client:
        try:
            resp = await client.post("/interrupt")
            return {"ok": resp.status_code in (200, 204)}
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/comfyui/image")
async def comfyui_image(
    filename: str, subfolder: str = "", type: str = "output",
    port: int = COMFYUI_PORTS[0],
):
    """Proxy a generated image so the UI stays on one origin."""
    async with httpx.AsyncClient(base_url=_comfyui_base(port), timeout=15) as client:
        try:
            resp = await client.get(
                "/view", params={"filename": filename, "subfolder": subfolder, "type": type}
            )
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
    return StreamingResponse(
        iter([resp.content]),
        media_type=resp.headers.get("content-type", "image/png"),
    )


# --------------------------------------------------------------------------
# Sharing the card between llama-swap and ComfyUI
#
# One 32 GB card, a 24 GB language model and a 25 GB video model: they cannot
# both be resident, and nothing arbitrates between them. llama-swap's
# `exclusive` groups only govern its own models -- it has no idea ComfyUI
# exists -- so the failure was ordinary and silent. ComfyUI holds the card after
# a generation, a chat request arrives, llama-server cannot allocate, and the
# only clue is an allocation error in a log nobody is reading.
#
# The console is the one process that sees both, and every /v1 request already
# passes through it, so this is where the two are made to take turns.
# --------------------------------------------------------------------------

# Both of these were constants and are now settings, because they are the two
# numbers that decide whether a chat request evicts somebody's image generation
# -- a judgement about how this particular machine is shared, which is not the
# same on every machine. Read at the point of use so a change takes effect
# without a restart.
def _comfyui_idle_vram() -> int:
    """Below this ComfyUI is not in anyone's way -- an idle instance still holds
    a few hundred MB of context and buffers."""
    return settings.get("comfyui_idle_gib") * 1024**3


def _vram_margin() -> int:
    """Added to a model's file size to decide whether it needs the card cleared.

    Generous on purpose: KV cache and compute buffers are not in the file size,
    and the two ways of being wrong are not equal. Freeing when it was not
    needed costs a reload; not freeing when it was needed is a failed request.
    """
    return settings.get("vram_margin_gib") * 1024**3

# One eviction at a time. Two chat requests arriving together would otherwise
# both decide to clear the card and both wait for it.
_vram_lock = asyncio.Lock()


async def _target_card(model_id: str, cards: list[dict]) -> dict | None:
    """The card this model will actually load onto.

    Read from the model entry's own `env`, which is where the console writes a
    card choice, resolved against what llama-server enumerates so that a
    selector naming a device no launcher can see does not silently decide the
    VRAM policy.

    An entry that pins nothing gets the first device a launcher offers, which is
    what llama.cpp itself would pick. That was this function's entire previous
    behaviour, written as `gpu.sample_dict(0)` -- correct while one card could
    run a model, and quietly wrong the moment a second runtime is configured.
    """
    if not cards:
        return None

    spec = config.read_model_spec(model_id) or {}
    environment = spec.get("env") or {}
    devices = backends.match(await backends.usable(), cards)

    chosen = next(
        (d for d in devices
         if d["env"] and all(environment.get(k) == v for k, v in d["env"].items())),
        None,
    )
    if chosen is None and devices:
        chosen = devices[0]

    address = (chosen or {}).get("pci_bdf_address")
    if address:
        wanted = containers.bus_key(address)
        for card in cards:
            if card.get("pci_bdf_address") and containers.bus_key(card["pci_bdf_address"]) == wanted:
                return card
    # Nothing resolved: the old assumption, kept as a fallback rather than as
    # the rule. Unknown has to mean "check something" here, not "check nothing".
    return cards[0]


def _shares_card(instance: dict, card: dict | None, by_port: dict[int, list[str]]) -> bool:
    """Whether this instance is on the card llama-server uses.

    Since a second GPU went in, "ComfyUI is holding VRAM" and "ComfyUI is in
    the way" stopped being the same statement. An instance on the 3060 competes
    with nothing an LLM does on the B70, and treating it as a rival meant
    clearing it off its own card for no reason -- or, worse, refusing a chat
    request with 503 because a card the model will never touch was busy.

    Answered by PCI address where the container mapping reaches: the port an
    instance answers on is published by exactly one container, and that
    container's device bindings name the card it was given. That join is exact,
    which the previous one was not -- two cards of the same model are the
    ordinary way to expand this machine, and a name cannot tell them apart.

    The name test stays as the fallback for an instance that is not in a
    container, or when Docker cannot be reached. ComfyUI reports `xpu:0
    Intel(R) Arc(TM) Pro B70 Graphics` and `cuda:0 NVIDIA GeForce RTX 3060 :
    cudaMallocAsync`, each containing what the telemetry provider calls the
    same card, so one substring test covers every vendor. Type alone would not
    do it: torch on ROCm calls itself `cuda`, which is indistinguishable from a
    real NVIDIA card.

    Unknown means yes, either way. Failing to free a card that needed freeing is
    an out-of-memory on load; freeing one that did not is a lost cache. Only one
    of those is worth defaulting to.
    """
    if card is None:
        return True

    address = card.get("pci_bdf_address")
    held = by_port.get(int(instance.get("port") or 0)) or []
    if address and held:
        return containers.bus_key(address) in {containers.bus_key(a) for a in held}

    name = (card.get("name") or "").strip()
    text = ((instance.get("device") or {}).get("name") or "").strip()
    if not name or not text:
        return True
    return name.lower() in text.lower()


async def _comfyui_held_vram() -> list[tuple[dict, int]]:
    """Instances holding more than an idle amount, with how much.

    Every card, because which of them are in the way is a question that needs
    the model's target, and that costs more to work out than this probe does.
    """
    found = await asyncio.gather(*(_probe_comfyui(p) for p in COMFYUI_PORTS))
    out = []
    for instance in found:
        if instance is None:
            continue
        held = (instance.get("device") or {}).get("torch_vram_total") or 0
        if held >= _comfyui_idle_vram():
            out.append((instance, held))
    return out


async def make_room_for(model_id: str) -> None:
    """Clear ComfyUI off the card if this model is about to need it.

    Does nothing in the common case -- the model is already resident, or there
    is room as things stand -- so the cost on a normal chat request is one local
    call to llama-swap.

    Raises rather than waiting when ComfyUI is mid-generation. /free is a flag
    ComfyUI consumes between prompts, so the memory would come back only after
    the current job finishes; a chat request that hangs for the three minutes a
    video takes is worse than one that says what is in the way.
    """
    if not model_id:
        return

    # An aliased name -- `claude-opus-5`, `gpt-5-codex` -- is a different string
    # for a model that may already be loaded. Resolved here so the comparison
    # below is against the config key, not against whatever the client called
    # it; otherwise every request from an Anthropic or Codex client looks like
    # a cold load and goes hunting for VRAM.
    model_id = config.canonical_model(model_id)

    running = await llamaswap.get_running()
    if any(entry.get("model") == model_id for entry in running):
        return

    async with _vram_lock:
        # Probed before anything else because "nothing is holding VRAM" is the
        # common answer and costs four local requests to reach. Filtered by
        # card afterwards rather than by asking again -- the answer is already
        # in hand and a second round would double the probes.
        anywhere = await _comfyui_held_vram()
        if not anywhere:
            return

        # The card this model will load onto, and the containers that hold the
        # cards -- both only now, because both cost more than the probe above
        # and neither is needed in the common case where nothing is held.
        cards = await gpu.list_devices()
        target = await _target_card(model_id, cards)
        by_port = await containers.port_cards(cards)

        held = [(i, b) for i, b in anywhere if _shares_card(i, target, by_port)]
        if not held:
            # Something is holding VRAM, but on another card. Nothing to do,
            # and in particular nothing to refuse the caller over.
            return

        # Only now is it worth asking how big the model is. Measured on the
        # target card rather than on device 0: with one card those were the
        # same number, and with two they are not.
        sample = (await gpu.sample_dict(target["index"]) if target else None) or {}
        need = sum(f["size_bytes"] for f in config.files_for_model(model_id)) + _vram_margin()
        total = (sample.get("memory_total_mib") or 0) * 1024**2
        used = (sample.get("memory_used_mib") or 0) * 1024**2
        if total and (total - used) >= need:
            return

        busy = [i for i, _ in held if i["queue_running"] or i["queue_pending"]]
        if busy:
            ports = "、".join(f":{i['port']}" for i in busy)
            raise HTTPException(
                status_code=503,
                detail=(
                    f"ComfyUI（{ports}）正在算圖，佔著顯示卡。"
                    "等它跑完，或先在 ComfyUI 介面中斷，再送這個請求。"
                ),
            )

        for instance, bytes_held in held:
            logger.info(
                "freeing %.1f GiB from ComfyUI :%d to make room for %s",
                bytes_held / 1024**3, instance["port"], model_id,
            )
            base = f"http://127.0.0.1:{instance['port']}"
            async with httpx.AsyncClient(base_url=base, timeout=10) as client:
                try:
                    await client.post(
                        "/free", json={"unload_models": True, "free_memory": True})
                except httpx.HTTPError as exc:
                    logger.warning("could not ask ComfyUI :%d to free: %s",
                                   instance["port"], exc)

        # Waited for rather than assumed: /free returns as soon as the flag is
        # set, and llama-server would start allocating against memory ComfyUI
        # has not released yet.
        for _ in range(60):
            await asyncio.sleep(0.5)
            # Filtered by card too, or this waits thirty seconds for an
            # instance on another GPU to release memory it was never asked for.
            still = await _comfyui_held_vram()
            if not [i for i, _ in still if _shares_card(i, target, by_port)]:
                logger.info("ComfyUI released the card")
                return
        logger.warning("ComfyUI still holds VRAM after 30s; loading %s anyway", model_id)


# --------------------------------------------------------------------------
# The filesystem
#
# This started as ComfyUI's model folders, which have no API: ComfyUI can say
# what it found but has no way to be given anything, so a checkpoint has always
# meant a shell on this machine. It now reaches whatever `files.py` is
# configured to expose.
#
# Every route here takes `require_owner` rather than the middleware's ordinary
# check. The middleware treats a session cookie and an API key alike, which is
# right for telemetry and wrong for this: an API key is pasted into a chat
# client and travels, and one that also opens a file browser hands out more than
# whoever minted it meant to. Sessions only, administrators only.
#
# Every path still goes through files.resolve(), which is what keeps a name from
# a browser from deciding which directory gets written to.
# --------------------------------------------------------------------------

# Types the browser may render in place. Everything else is sent as a download,
# because serving an arbitrary file inline from this origin is stored XSS: an
# HTML file in some directory, opened in a tab, runs script against the session
# that opened it. Images and media have no such reach, and the headers below
# hold the line for anything mislabelled.
INLINE_TYPES = ("image/", "video/", "audio/")

# Belt and braces on top of the allow-list. `nosniff` stops the browser
# second-guessing a Content-Type it dislikes, and the sandbox directive strips
# the response of an origin, so even a document that got through executes with
# no access to cookies or storage.
RAW_HEADERS = {
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    "cache-control": "private, max-age=60",
}


@contextlib.contextmanager
def _file_errors():
    """One translation from filesystem failures to status codes.

    Collected here because eleven routes raise the same six exceptions, and
    repeating the mapping is how one of them ends up answering 500 for a name
    that is merely taken.
    """
    try:
        yield
    except files.Stale as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except files.TooBig as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except files.Denied as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except files.BadPath as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=f"{exc} 已存在") from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"找不到 {exc}") from exc
    except IsADirectoryError as exc:
        raise HTTPException(status_code=409, detail="資料夾不是空的") from exc
    except NotADirectoryError as exc:
        raise HTTPException(status_code=400, detail=f"{exc} 不是資料夾") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=f"{exc} 不可寫入") from exc


@app.get("/api/fs/roots")
async def file_roots(_: dict = Depends(auth.require_owner)):
    return {"roots": files.roots()}


@app.get("/api/fs")
async def file_listing(
    root: str, path: str = "", hidden: bool = False, query: str = "",
    _: dict = Depends(auth.require_owner),
):
    """One location: what is in it, whether it takes writes, and space left.

    Answered in a single call because the page needs all of it to draw a row --
    separate round trips would show the list, then belatedly grey out buttons.

    `query` filters here rather than in the browser so that it still reaches
    names past the truncation point of a five-figure directory.
    """
    with _file_errors():
        return files.listing(root, path, hidden, query)


@app.get("/api/fs/locate")
async def file_locate(path: str, _: dict = Depends(auth.require_owner)):
    """Where an absolute path lands: which root, and where inside it.

    What the address bar submits is whatever somebody pasted out of a terminal.
    Turning that into a root and a relative path needs `~` expanded against this
    process, `..` collapsed, and symlinks followed before the deny list is
    consulted -- so it happens here rather than by prefix-matching in the
    browser.
    """
    with _file_errors():
        return files.locate(path)


@app.get("/api/fs/size")
async def file_tree_size(
    root: str, path: str = "", name: str | None = None,
    _: dict = Depends(auth.require_owner),
):
    """How much is under one directory. Its own route because it is the
    expensive question: listing used to answer it for every subdirectory at
    once, which over a home directory walks the whole disk per navigation."""
    with _file_errors():
        return files.tree_size(root, path, name)


@app.get("/api/fs/peek")
async def file_peek(
    root: str, name: str, path: str = "",
    _: dict = Depends(auth.require_owner),
):
    """What can be said about a file without reading all of it: a model
    header, the first page of text, or an honest nothing."""
    with _file_errors():
        return files.peek(root, path, name)


@app.get("/api/fs/raw")
async def file_raw(
    request: Request, root: str, name: str, path: str = "",
    download: bool = False, partial: bool = False,
    _: dict = Depends(auth.require_owner),
):
    """The bytes, with Range support.

    Range is not a nicety here: `<video>` will not let anyone drag the scrubber
    unless the server answers 206, so a two-minute render plays from the start
    or not at all.
    """
    with _file_errors():
        target, size = files.open_file(root, path, name, partial)

    media = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    inline = not download and media.startswith(INLINE_TYPES)
    disposition = "inline" if inline else "attachment"
    headers = {
        **RAW_HEADERS,
        "accept-ranges": "bytes",
        # RFC 5987 rather than a bare filename: these names are Chinese as often
        # as not, and a raw one either mangles or breaks the header.
        "content-disposition": f"{disposition}; filename*=UTF-8''{quote(target.name)}",
    }

    start, end = 0, size - 1
    status = 200
    raw_range = request.headers.get("range", "")
    if raw_range.startswith("bytes=") and size:
        spec = raw_range[6:].split(",")[0].strip()
        first, _, last = spec.partition("-")
        try:
            if first:
                start = int(first)
                end = int(last) if last else size - 1
            elif last:
                # A suffix range: the final N bytes, which is how some players
                # read a container's trailing index.
                start = max(0, size - int(last))
            else:
                raise ValueError(spec)
        except ValueError:
            raise HTTPException(status_code=400, detail="Range 格式錯誤")
        end = min(end, size - 1)
        if start > end:
            return Response(
                status_code=416,
                headers={"content-range": f"bytes */{size}", **RAW_HEADERS},
            )
        status = 206
        headers["content-range"] = f"bytes {start}-{end}/{size}"

    length = end - start + 1 if size else 0
    headers["content-length"] = str(length)
    return StreamingResponse(
        files.stream(target, start, length),
        status_code=status, media_type=media, headers=headers,
    )


@app.get("/api/fs/thumb")
async def file_thumbnail(
    root: str, name: str, path: str = "",
    _: dict = Depends(auth.require_owner),
):
    """A 320 px WebP of an image, made once and cached.

    Its own route rather than a flag on /raw because the failure modes differ:
    an unreadable image is not a missing file, and answering 415 lets the grid
    fall back to an icon instead of drawing a broken picture.
    """
    if not files.can_thumbnail(name):
        raise HTTPException(status_code=415, detail="這個格式沒有縮圖")
    with _file_errors():
        try:
            cached = await asyncio.to_thread(files.thumbnail, root, path, name)
        except files.BadPath:
            raise
        except Exception as exc:  # Pillow raises its own hierarchy for these.
            raise HTTPException(status_code=415, detail=f"讀不出圖片：{exc}") from exc
    return FileResponse(
        cached, media_type="image/webp",
        headers={**RAW_HEADERS, "cache-control": "private, max-age=86400"},
    )


@app.post("/api/fs/folder")
async def file_mkdir(
    root: str, name: str, path: str = "",
    _: dict = Depends(auth.require_owner),
):
    with _file_errors():
        return files.mkdir(root, path, name)


@app.get("/api/fs/text")
async def file_read_text(
    root: str, name: str, path: str = "",
    _: dict = Depends(auth.require_owner),
):
    """A whole text file, for editing. Distinct from /peek, which serves a
    truncated head: an editor given a prefix would write it back over the
    rest."""
    with _file_errors():
        return files.read_text(root, path, name)


class TextBody(BaseModel):
    text: str
    # The mtime read_text handed out. Sent back so a file changed underneath
    # the editor is refused rather than silently overwritten.
    mtime: float | None = None


@app.post("/api/fs/text")
async def file_write_text(
    body: TextBody, root: str, name: str, path: str = "",
    _: dict = Depends(auth.require_owner),
):
    with _file_errors():
        return files.write_text(root, path, name, body.text, body.mtime)


@app.post("/api/fs/rename")
async def file_rename(
    root: str, name: str, to: str, path: str = "",
    _: dict = Depends(auth.require_owner),
):
    with _file_errors():
        return files.rename(root, path, name, to)


@app.post("/api/fs/move")
async def file_move(
    root: str, name: str, to_root: str, path: str = "", to_path: str = "",
    _: dict = Depends(auth.require_owner),
):
    with _file_errors():
        return files.move(root, path, name, to_root, to_path)


@app.delete("/api/fs")
async def file_delete(
    root: str, name: str, path: str = "", partial: bool = False,
    _: dict = Depends(auth.require_owner),
):
    with _file_errors():
        return files.delete(root, path, name, partial)


@app.get("/api/fs/offset")
async def file_offset(
    root: str, name: str, path: str = "",
    _: dict = Depends(auth.require_owner),
):
    """What the server already holds, so an interrupted upload resumes."""
    with _file_errors():
        return files.upload_offset(root, path, name)


@app.put("/api/fs/upload")
async def file_upload(
    request: Request, root: str, name: str, offset: int, total: int, path: str = "",
    _: dict = Depends(auth.require_owner),
):
    """One chunk of a file, as a raw body.

    Deliberately not a multipart form: the whole point is that the bytes go from
    the socket to the disk without being assembled anywhere in between.
    """
    with _file_errors():
        try:
            result = await files.receive(
                root, path, name, offset, total, request.stream(),
            )
        except files.BadPath:
            # A ValueError too, and the handler below would flatten Denied's 403
            # into a 400. Let the context manager have it.
            raise
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not result.get("ok"):
        # 409 with the length actually held: the client re-syncs and carries on
        # rather than starting the file again.
        return JSONResponse(result, status_code=409)
    return result



# --------------------------------------------------------------------------
# The web
#
# On this side because the sandbox cannot: its frame has no origin, so every
# request it makes carries `Origin: null` and reaches only the few hosts that
# allow that. Search engines do not, and a proxy permissive enough for an
# opaque origin to call would be permissive enough for any page to call.
#
# Behind require_owner for the same reason the filesystem is. An API key is
# pasted into a chat client and travels; one that also turns this machine into
# a fetcher of arbitrary URLs hands out more than whoever minted it intended.
# --------------------------------------------------------------------------

@app.get("/api/search")
async def web_search(q: str, limit: int = 8, _: dict = Depends(auth.require_owner)):
    try:
        return await search.search(q, limit)
    except search.Unavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/search/read")
async def web_read(url: str, query: str = "", _: dict = Depends(auth.require_owner)):
    """One page, as text. Reading is a separate call from searching because a
    model should choose what to open rather than being handed eight pages it
    did not ask for.

    `query` narrows it to the passages that answer that, which is most of what
    keeps a long page from spending the context window on its own introduction."""
    try:
        return await search.read(url, query)
    except search.Unavailable as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/search/available")
async def web_search_available(_: dict = Depends(auth.require_owner)):
    """Whether to offer the tool at all. One that is offered and then always
    fails is worse than one that was never mentioned."""
    return {"available": await search.available()}



# --------------------------------------------------------------------------
# A font the sandbox can reach
#
# matplotlib inside Pyodide ships DejaVu Sans and nothing else, so a chart
# labelled in Chinese comes out as rows of tofu. The fix is a font file, and
# getting one to the sandbox is the awkward part: that frame has no origin, so
# it can only fetch what says it may be fetched from anywhere.
#
# Hence outside /api and hence the wildcard. Both are deliberate and neither is
# a hole. The middleware guards /api because those routes answer with this
# machine's state; this one answers with a font that ships in Ubuntu, is the
# same for every reader, and reveals nothing by being read. A wildcard on one
# static file is not the open proxy that a wildcard on a fetch endpoint would
# have been.
#
# Served from the system rather than copied into the repository: it is 3.8 MB,
# it is already installed, and a second copy is a second thing to keep current.
# --------------------------------------------------------------------------

CJK_FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
)


@app.get("/fonts/cjk.ttf")
async def cjk_font():
    """A CJK font, for anything drawing text in a sandbox.

    DroidSansFallback first: 3.8 MB against Noto CJK's 18.6, and a plain TTF
    rather than a collection, which is what matplotlib's FreeType can open
    without being told which face it wants.
    """
    for candidate in CJK_FONT_CANDIDATES:
        path = Path(candidate)
        if path.is_file():
            return FileResponse(
                path,
                media_type="font/ttf",
                headers={
                    "access-control-allow-origin": "*",
                    # A year. The file changes when the distribution changes it,
                    # which is not something a reader needs re-checked hourly.
                    "cache-control": "public, max-age=31536000, immutable",
                },
            )
    raise HTTPException(status_code=404, detail="這台機器上沒有找到 CJK 字型")


# --------------------------------------------------------------------------
# Conversation history
# --------------------------------------------------------------------------

def _caller_id(request: Request) -> int | None:
    """Whose conversations these are. None before any account exists, which is
    the same state in which authentication is off."""
    identity = getattr(request.state, "identity", None)
    return (identity or {}).get("user_id")


class ChatSave(BaseModel):
    id: int | None = None
    model: str = ""
    params: dict = Field(default_factory=dict)
    messages: list[dict] = Field(default_factory=list)
    title: str | None = None


@app.get("/api/chats")
async def list_chats(request: Request, q: str = ""):
    user_id = _caller_id(request)
    if q.strip():
        return chats.search(q.strip(), user_id)
    return chats.list_conversations(user_id)


@app.post("/api/chats")
async def save_chat(request: Request, payload: ChatSave):
    try:
        return chats.save(
            payload.id,
            messages=payload.messages,
            model=payload.model,
            params=payload.params,
            user_id=_caller_id(request),
            title=payload.title,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="no such conversation")


@app.get("/api/chats/{conversation_id}")
async def read_chat(conversation_id: int):
    conversation = chats.get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="no such conversation")
    return conversation


@app.patch("/api/chats/{conversation_id}")
async def patch_chat(conversation_id: int, payload: dict = Body(...)):
    ok = chats.update(
        conversation_id,
        title=payload.get("title"),
        pinned=payload.get("pinned"),
    )
    if not ok:
        raise HTTPException(status_code=404, detail="nothing to update")
    return {"ok": True}


@app.delete("/api/chats/{conversation_id}")
async def remove_chat(conversation_id: int):
    if not chats.delete(conversation_id):
        raise HTTPException(status_code=404, detail="no such conversation")
    return {"ok": True}


# --------------------------------------------------------------------------
# Users and API keys
# --------------------------------------------------------------------------

class NewUser(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=4)
    display_name: str = ""
    role: str = "member"


@app.get("/api/users")
async def read_users():
    return users.list_users()


@app.post("/api/users")
async def add_user(payload: NewUser):
    try:
        return users.create_user(payload.username, payload.password, payload.display_name, payload.role)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/api/users/{user_id}")
async def remove_user(user_id: int):
    if not users.delete_user(user_id):
        raise HTTPException(status_code=404, detail="no such user")
    return {"ok": True}


@app.post("/api/users/{user_id}/password")
async def change_password(user_id: int, payload: dict = Body(...)):
    password = payload.get("password", "")
    if len(password) < 4:
        raise HTTPException(status_code=400, detail="password too short")
    return {"ok": users.set_password(user_id, password)}


@app.get("/api/api-keys")
async def read_api_keys():
    return users.list_api_keys()


@app.post("/api/api-keys")
async def add_api_key(payload: dict = Body(...)):
    user_id, name = payload.get("user_id"), payload.get("name", "key")
    if not isinstance(user_id, int):
        raise HTTPException(status_code=400, detail="user_id is required")
    return users.create_api_key(user_id, name)


@app.delete("/api/api-keys/{key_id}")
async def remove_api_key(key_id: int):
    if not users.delete_api_key(key_id):
        raise HTTPException(status_code=404, detail="no such key")
    return {"ok": True}


# --------------------------------------------------------------------------
# Event stream
# --------------------------------------------------------------------------

async def _merged_stream() -> AsyncIterator[str]:
    """One SSE stream carrying llama-swap events, GPU samples and downloads.

    Merged here rather than opening several connections from the browser so the
    UI sees a single ordered timeline, and so a llama-swap outage does not also
    stop GPU readings.
    """
    queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=256)

    async def pump_llamaswap() -> None:
        async for event in llamaswap.events():
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(event)

    async def pump_gpu() -> None:
        while True:
            samples = gpu_history.latest_all()
            if samples:
                with contextlib.suppress(asyncio.QueueFull):
                    # A list even for one card: the client renders per device,
                    # and a payload whose shape depends on how many cards are
                    # installed would need two code paths on both sides.
                    queue.put_nowait({"type": "gpu", "data": samples})
            # Reading /proc is cheap enough to do inline; keeping it on the same
            # tick means the CPU and GPU figures on screen describe one moment.
            with contextlib.suppress(Exception):
                queue.put_nowait({"type": "system", "data": system.sample()})
            await asyncio.sleep(GPU_POLL_SECONDS)

    async def pump_downloads() -> None:
        """Emitted while something is downloading, plus one snapshot after the
        last one stops.

        Sending only while active is what froze the progress bar just short of
        the end: the tick that would have carried state="done" and 100% is
        exactly the tick this loop skipped, so the client's newest snapshot
        stayed the one from a second earlier. The transition to idle has to be
        reported once, or a finished download is indistinguishable from a
        stalled one.
        """
        was_active = False
        while True:
            active = catalog.active_count() > 0
            if active or was_active:
                with contextlib.suppress(asyncio.QueueFull):
                    queue.put_nowait({"type": "downloads", "data": catalog.status()})
            was_active = active
            await asyncio.sleep(1.0 if active else 3.0)

    async def pump_journal() -> None:
        """Forward new log lines.

        Nothing is logged in here: this process's own journal is one of the
        sources, so a line written per line read would feed itself.
        """
        queue_in = journal.subscribe()
        try:
            while True:
                line = await queue_in.get()
                with contextlib.suppress(asyncio.QueueFull):
                    queue.put_nowait({"type": "journal", "data": line})
        finally:
            journal.unsubscribe(queue_in)

    tasks = [
        asyncio.create_task(pump_journal()),
        asyncio.create_task(pump_llamaswap()),
        asyncio.create_task(pump_gpu()),
        asyncio.create_task(pump_downloads()),
    ]
    try:
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=15.0)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                continue
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@app.get("/api/stream")
async def stream():
    return StreamingResponse(
        _merged_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/health")
async def health():
    return {"ok": True}


# --------------------------------------------------------------------------
# Endpoints
# --------------------------------------------------------------------------

# Mirrors ~/ai/caddy/Caddyfile. Kept here rather than in the frontend so there
# is a single place to change, and each entry is probed before being shown --
# a dashboard that lists an endpoint nobody is listening on is worse than one
# that lists nothing.
_ENDPOINTS = [
    {
        "key": "console",
        "label": "主控台",
        "scheme": "https",
        "port": 8443,
        "path": "/",
        "note": "瀏覽器使用。憑證由本地 CA 簽發，首次連線需接受警告。",
        "encrypted": True,
    },
    {
        "key": "api-http",
        "label": "API（純 HTTP）",
        "scheme": "http",
        "port": 8000,
        "path": "/v1",
        "note": "給不方便處理自簽憑證的用戶端，例如 Opencode。只開放 /v1，"
                "OpenAI 與 Anthropic 兩種格式都收，API key 在區網上是明文。",
        "encrypted": False,
    },
    {
        "key": "api-https",
        "label": "API（加密）",
        "scheme": "https",
        "port": 8443,
        "path": "/v1",
        "note": "同一組端點但走 TLS：/v1/chat/completions 是 OpenAI 格式，"
                "/v1/messages 是 Anthropic 格式。用戶端需信任本地 CA。",
        "encrypted": True,
    },
    {
        "key": "comfyui",
        "label": "ComfyUI",
        "scheme": "https",
        "port": 8444,
        "path": "/",
        "note": "圖像生成的原生介面，由主控台的登入保護。",
        "encrypted": True,
    },
]


def _port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.4)
        return probe.connect_ex(("127.0.0.1", port)) == 0


@app.get("/api/channels")
async def read_channels():
    """Optional ways in, and whether each is currently open."""
    return channels.status()


@app.post("/api/channels/{name}")
async def write_channel(name: str, payload: dict):
    """Open or close one channel. The console's own site is not in this set."""
    try:
        return await channels.set_enabled(name, bool(payload.get("enabled")))
    except KeyError:
        raise HTTPException(status_code=404, detail="no such channel")
    except FileNotFoundError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/channels/{name}/scopes")
async def write_channel_scopes(name: str, payload: dict):
    """Which networks may reach one channel, as a Caddy bind list."""
    scopes = payload.get("scopes")
    if not isinstance(scopes, list):
        raise HTTPException(status_code=400, detail="scopes must be a list")
    try:
        return await channels.set_scopes(name, scopes)
    except KeyError:
        raise HTTPException(status_code=404, detail="no such channel")
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/endpoints")
async def read_endpoints():
    """Reachable ways in, each checked rather than assumed."""
    return [{**entry, "listening": _port_open(entry["port"])} for entry in _ENDPOINTS]


async def _tailscale() -> dict | None:
    """This node's Tailscale identity, or None when it is not running.

    Read from the CLI rather than assumed from an interface address: only
    tailscaled knows the MagicDNS name, and whether the tailnet has HTTPS
    certificates enabled at all.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            "tailscale", "status", "--json",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), 5)
    except (FileNotFoundError, asyncio.TimeoutError):
        return None
    if proc.returncode != 0:
        return None

    try:
        status = json.loads(stdout)
    except json.JSONDecodeError:
        return None

    self_node = status.get("Self") or {}
    ips = [ip for ip in (self_node.get("TailscaleIPs") or []) if ":" not in ip]
    dns_name = (self_node.get("DNSName") or "").rstrip(".")
    return {
        "running": bool(status.get("BackendState") == "Running"),
        "ip": ips[0] if ips else None,
        "dns_name": dns_name or None,
        # Non-empty only when the tailnet has HTTPS enabled, which is what makes
        # a publicly trusted certificate possible instead of a private CA.
        "cert_domains": status.get("CertDomains") or [],
    }


@app.get("/api/network")
async def read_network():
    """Every address this host can be reached on, so the UI can offer the right
    one instead of whichever the browser happened to use."""
    hosts = [{"key": "local", "label": "本機", "host": "127.0.0.1",
              "note": "只有這台機器自己"}]

    lan = None
    with contextlib.suppress(OSError):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            # No packet is sent; this just asks the routing table which source
            # address would be used, which is the LAN address in practice.
            probe.connect(("1.1.1.1", 80))
            lan = probe.getsockname()[0]
    if lan:
        hosts.append({"key": "lan", "label": "區域網路", "host": lan,
                      "note": "同一個家用網路內的裝置"})

    ts = await _tailscale()
    if ts and ts.get("running"):
        # The IPv4 address comes first because it is the one that works today.
        # The MagicDNS name needs a certificate Caddy cannot fetch without
        # `tailscale set --operator`, so leading with it would send people to
        # an address that fails its TLS handshake.
        if ts.get("ip"):
            hosts.append({
                "key": "tailscale-ip", "label": "Tailscale", "host": ts["ip"],
                "note": "任何地方都能連，流量由 WireGuard 加密",
                "tailscale": True,
                "cert_available": False,
            })
        if ts.get("dns_name"):
            hosts.append({
                "key": "tailscale-dns", "label": "Tailscale 網域", "host": ts["dns_name"],
                "note": "較好記，但需要先取得憑證才能走 HTTPS",
                "tailscale": True,
                "cert_available": ts["dns_name"] in ts["cert_domains"],
            })

    return {"hosts": hosts, "tailscale": ts}


# --------------------------------------------------------------------------
# Model proxy
#
# Two request formats reach the same models. `/v1/chat/completions` is the
# OpenAI shape every client speaks; `/v1/messages` is Anthropic's, which
# llama-server translates internally and answers with Anthropic-shaped content
# blocks, `stop_reason` and SSE events. Nothing here has to know the difference
# -- the route below is a catch-all and forwards whatever arrives -- but the
# logging does, because the two put the same facts in different places.
# --------------------------------------------------------------------------

def _log_request_shape(path: str, body: bytes, request: Request) -> None:
    """Summarise what a client actually sent.

    Third-party agents are opaque about which knobs they translate into request
    fields -- documentation and issue trackers disagree, and the only authority
    is the bytes that arrive. This proxy is the one place that sees them, so it
    reports the shape (never the prompt text) of every completion request, in
    either format.
    """
    if not body:
        return
    if path.startswith("chat/completions"):
        shape = "openai"
    elif path.startswith("messages") and not path.startswith("messages/count"):
        shape = "anthropic"
    elif path.startswith("responses"):
        shape = "responses"
    else:
        return
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return

    # The Responses format keeps its turns under `input`, and the part of it
    # worth recording is the `type` on each tool result: llama.cpp accepts only
    # a fixed set, and which strings Codex actually sends is not written down
    # anywhere -- it was "output_text" until it was something else, and the
    # error names the rejected value without naming the one that arrived.
    if shape == "responses":
        items = payload.get("input") or []
        kinds: list[str] = []
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict):
                continue
            if item.get("type") != "function_call_output":
                continue
            out = item.get("output")
            if isinstance(out, str):
                kinds.append("<string>")
            elif isinstance(out, list):
                for part in out:
                    kinds.append(
                        part.get("type", "<no type>") if isinstance(part, dict)
                        else f"<{type(part).__name__}>")
        logger.info(
            "/v1 responses from %s: model=%s input=%d tools=%d "
            "tool_output_types=%s",
            request.headers.get("user-agent", "?")[:40],
            payload.get("model"),
            len(items) if isinstance(items, list) else 0,
            len(payload.get("tools") or []),
            kinds or "none",
        )
        return

    agent = request.headers.get("user-agent", "?")[:40]
    reasoning_fields = {
        key: payload[key] for key in
        ("chat_template_kwargs", "reasoning_budget_tokens", "thinking",
         "reasoning", "reasoning_effort", "enable_thinking")
        if key in payload
    }
    messages = payload.get("messages") or []
    logger.info(
        "/v1 %s request from %s: model=%s messages=%d tools=%d stream=%s "
        "max_tokens=%s temperature=%s multimodal=%s reasoning_fields=%s",
        shape,
        agent,
        payload.get("model"),
        # The Anthropic format carries the system prompt outside the message
        # list, so counting messages alone would report one fewer turn than the
        # OpenAI form of the same conversation.
        len(messages) + (1 if shape == "anthropic" and payload.get("system") else 0),
        len(payload.get("tools") or []),
        payload.get("stream"),
        payload.get("max_tokens") or payload.get("max_completion_tokens"),
        payload.get("temperature"),
        # Content parts rather than a plain string means an image or file made
        # it into the request instead of being stripped by the client.
        any(isinstance(m.get("content"), list) for m in messages),
        reasoning_fields or "none",
    )


@app.api_route("/v1/{path:path}", methods=["GET", "POST", "OPTIONS"])
async def openai_proxy(path: str, request: Request):
    """Forward /v1/* to llama-swap behind this console's authentication.

    llama-swap listens on 127.0.0.1 with no auth of its own, so this is what
    lets a family member's app reach the models with an API key instead of the
    port being open to anyone on the LAN.

    Every path under /v1 is carried, not a listed set: `chat/completions`,
    `completions`, `embeddings`, `models`, and Anthropic's `messages` and
    `messages/count_tokens`. An Anthropic-format client authenticates the way
    it already does -- `x-api-key`, which `auth.identify` accepts beside
    `Authorization: Bearer` -- and names its model the same way, so `model`
    must be a key from llama-swap's config rather than a `claude-*` id.

    Responses are streamed rather than buffered: a chat completion with
    stream=true must arrive token by token, and reading it to completion first
    would turn every reply into one long pause.
    """
    body = await request.body()
    _log_request_shape(path, body, request)

    # Only requests that name a model can cause one to be loaded; /v1/models and
    # the like are just reads and must not stall behind an eviction.
    if request.method == "POST" and body:
        try:
            wanted = json.loads(body).get("model")
        except (ValueError, AttributeError):
            wanted = None
        if isinstance(wanted, str):
            await make_room_for(wanted)

    headers = {
        key: value for key, value in request.headers.items()
        # Hop-by-hop and identity headers are dropped: Host would be wrong for
        # the upstream, and forwarding the caller's Authorization would hand
        # llama-swap a console API key it cannot interpret.
        if key.lower() not in {"host", "authorization", "x-api-key", "cookie",
                               "content-length", "connection"}
    }

    client = httpx.AsyncClient(base_url=llamaswap.BASE_URL, timeout=None)
    upstream = client.build_request(
        request.method, f"/v1/{path}", content=body, headers=headers,
        params=request.query_params,
    )
    try:
        response = await client.send(upstream, stream=True)
    except httpx.HTTPError as exc:
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"llama-swap unreachable: {exc}") from exc

    async def body_iterator():
        try:
            async for chunk in response.aiter_raw():
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()

    return StreamingResponse(
        body_iterator(),
        status_code=response.status_code,
        media_type=response.headers.get("content-type"),
        headers={"Cache-Control": "no-cache"} if "event-stream" in
                 response.headers.get("content-type", "") else None,
    )


# --------------------------------------------------------------------------
# Static UI (production build). Mounted last so it cannot shadow /api.
# --------------------------------------------------------------------------

if WEB_DIST.is_dir():
    # Vite fingerprints every asset, so the file at a given name can never
    # change: caching it for a year costs nothing and saves the round trip.
    class _ImmutableAssets(StaticFiles):
        def file_response(self, *args, **kwargs):  # type: ignore[override]
            response = super().file_response(*args, **kwargs)
            response.headers["cache-control"] = "public, max-age=31536000, immutable"
            return response

    app.mount("/assets", _ImmutableAssets(directory=WEB_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def spa(full_path: str):
        """A real file if there is one, otherwise the shell.

        Only /assets was mounted, so everything Vite copies from public/ --
        favicon.svg, icons.svg, the logo -- fell through to here and was
        answered with index.html under its own name. Nothing complained: the
        browser asked for an icon, got HTML, and silently showed none.

        Files are looked up before the fallback because a request for a path
        that exists is never a route. The resolved path is checked against the
        directory rather than the string, since that is the only form that
        accounts for `..` and for a symlink pointing out of the tree.

        The shell itself must never be cached: it carries the hashed names of
        the current bundle, so a stale copy
        points a browser at the previous build and every deployment silently
        fails to arrive. It had an ETag but no Cache-Control, which leaves the
        browser to invent a freshness lifetime of its own -- and it did.
        """
        if full_path:
            candidate = (WEB_DIST / full_path).resolve()
            if candidate.is_file() and WEB_DIST.resolve() in candidate.parents:
                # Unhashed, so it can change under a fixed name: revalidate
                # rather than trust a copy, which is the opposite of /assets.
                return FileResponse(
                    candidate, headers={"cache-control": "no-cache, must-revalidate"})

        return FileResponse(
            WEB_DIST / "index.html",
            headers={"cache-control": "no-cache, must-revalidate"},
        )
