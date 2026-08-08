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
import socket
from pathlib import Path
from typing import AsyncIterator

import httpx
from fastapi import Body, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import auth, catalog, config, gpu, llamaswap, system, users

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

COMFYUI_URL = "http://127.0.0.1:8188"
GPU_POLL_SECONDS = 2.0
WEB_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"

app = FastAPI(title="AI Console", version="0.1.0")

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
    if not auth.enforcement_enabled():
        logger.warning(
            "no accounts exist yet, so authentication is OFF. It switches on by "
            "itself as soon as the first user is created."
        )


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

@app.get("/api/gpu")
async def read_gpu():
    return await gpu.sample_dict(0) or {"error": "xpu-smi unavailable"}


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
    props_list = await asyncio.gather(*(llamaswap.get_props(p) for p in proxies.values()))
    props = dict(zip(proxies.keys(), props_list))

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


@app.post("/api/models")
async def create_model(spec: ModelSpec):
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
    )
    return {"ok": True, "id": spec.id}


@app.get("/api/models/{model_id}/files")
async def model_files(model_id: str):
    """What deleting this model would remove from disk, before deciding to."""
    return config.files_for_model(model_id)


@app.delete("/api/models/{model_id}")
async def remove_model(model_id: str, delete_files: bool = False):
    result = await config.delete_model(model_id, delete_files=delete_files)
    if result is None:
        raise HTTPException(status_code=404, detail="no such model")
    return {"ok": True, **result}


@app.delete("/api/files/{filename}")
async def remove_file(filename: str):
    result = config.delete_file(filename)
    if not result["ok"]:
        raise HTTPException(status_code=409, detail=result["reason"])
    return result


@app.get("/api/files/partials")
async def read_partials():
    return config.list_partials()


@app.delete("/api/files/partials/{filename}")
async def remove_partial(filename: str):
    result = config.delete_partial(filename)
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
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"invalid YAML: {exc}") from exc
    return {"ok": True}


# --------------------------------------------------------------------------
# Catalog
# --------------------------------------------------------------------------

@app.get("/api/catalog/search")
async def catalog_search(q: str, limit: int = 20):
    return await catalog.search(q, limit)


@app.get("/api/catalog/files")
async def catalog_files(repo_id: str):
    return await catalog.list_files(repo_id)


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

@app.get("/api/comfyui")
async def read_comfyui():
    """ComfyUI liveness and queue depth.

    Reported as unreachable rather than raising: ComfyUI being down is a normal
    state for this console to display, not an error of its own.
    """
    async with httpx.AsyncClient(base_url=COMFYUI_URL, timeout=3) as client:
        try:
            stats, queue = await asyncio.gather(
                client.get("/system_stats"), client.get("/queue")
            )
            stats.raise_for_status()
            queue.raise_for_status()
        except httpx.HTTPError:
            return {"reachable": False}

    q, s = queue.json(), stats.json()
    return {
        "reachable": True,
        "version": s.get("system", {}).get("comfyui_version"),
        "python": s.get("system", {}).get("python_version", "").split()[0],
        "devices": s.get("devices", []),
        "queue_running": len(q.get("queue_running", [])),
        "queue_pending": len(q.get("queue_pending", [])),
    }


@app.get("/api/comfyui/history")
async def comfyui_history(limit: int = 12):
    async with httpx.AsyncClient(base_url=COMFYUI_URL, timeout=5) as client:
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
async def comfyui_interrupt():
    async with httpx.AsyncClient(base_url=COMFYUI_URL, timeout=5) as client:
        try:
            resp = await client.post("/interrupt")
            return {"ok": resp.status_code in (200, 204)}
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/comfyui/image")
async def comfyui_image(filename: str, subfolder: str = "", type: str = "output"):
    """Proxy a generated image so the UI stays on one origin."""
    async with httpx.AsyncClient(base_url=COMFYUI_URL, timeout=15) as client:
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
            sample = await gpu.sample_dict(0)
            if sample is not None:
                with contextlib.suppress(asyncio.QueueFull):
                    queue.put_nowait({"type": "gpu", "data": sample})
            # Reading /proc is cheap enough to do inline; keeping it on the same
            # tick means the CPU and GPU figures on screen describe one moment.
            with contextlib.suppress(Exception):
                queue.put_nowait({"type": "system", "data": system.sample()})
            await asyncio.sleep(GPU_POLL_SECONDS)

    async def pump_downloads() -> None:
        """Only emitted while something is downloading, so an idle console is
        not woken once a second for an empty list."""
        while True:
            if catalog.active_count():
                with contextlib.suppress(asyncio.QueueFull):
                    queue.put_nowait({"type": "downloads", "data": catalog.status()})
                await asyncio.sleep(1.0)
            else:
                await asyncio.sleep(3.0)

    tasks = [
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
        "note": "給不方便處理自簽憑證的用戶端，例如 opencode。只開放 /v1，"
                "API key 在區網上是明文。",
        "encrypted": False,
    },
    {
        "key": "api-https",
        "label": "API（加密）",
        "scheme": "https",
        "port": 8443,
        "path": "/v1",
        "note": "同一個 OpenAI 相容端點，但走 TLS。用戶端需信任本地 CA。",
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
# OpenAI-compatible proxy
# --------------------------------------------------------------------------

@app.api_route("/v1/{path:path}", methods=["GET", "POST", "OPTIONS"])
async def openai_proxy(path: str, request: Request):
    """Forward /v1/* to llama-swap behind this console's authentication.

    llama-swap listens on 127.0.0.1 with no auth of its own, so this is what
    lets a family member's app reach the models with an API key instead of the
    port being open to anyone on the LAN.

    Responses are streamed rather than buffered: a chat completion with
    stream=true must arrive token by token, and reading it to completion first
    would turn every reply into one long pause.
    """
    body = await request.body()
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
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def spa(full_path: str):
        return FileResponse(WEB_DIST / "index.html")
