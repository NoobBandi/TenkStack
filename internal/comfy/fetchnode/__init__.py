"""TenkStack model fetch: missing models downloaded by the server, not the browser.

ComfyUI's missing-models dialog downloads a model to the machine the
browser is on, which for a ComfyUI running on another box is the wrong
machine: the file then has to be carried over by hand. This adds a panel
beside that dialog that asks this server to fetch the same files into its
own models folders, with progress, and refreshes the node dropdowns when
they land. (Upstream is working on the same thing -- Comfy-Org/ComfyUI_frontend
#12844 -- and this steps aside the day the frontend does it itself.)

Written by the TenkStack console into the shared user storage and linked
into custom_nodes by the managed pre-start hook, so a console update
reaches every instance on its next start. It adds no nodes.

Only https, only from the hosts models are published on, and only into a
folder ComfyUI already knows, under a name that stays inside it.
"""

import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import folder_paths
from aiohttp import web
from server import PromptServer

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
# Loaded as a single file, custom_nodes/tenkstack_fetch.py, linked to this
# one: ComfyUI-Manager treats every folder there that is not from its
# registry as a git checkout and fails to `git pull` it on every update,
# and it leaves single files alone.
#
# The web folder is registered here rather than through WEB_DIRECTORY: for a
# single-file node ComfyUI files it under the module's full path, which
# yields /extensions//root/... -- a URL its own router then refuses. The
# table is read when the routes are built, after every node has loaded.
WEB_DIRECTORY = None
try:
    import nodes as _nodes

    _nodes.EXTENSION_WEB_DIRS["tenkstack_fetch"] = os.path.join(
        os.path.dirname(os.path.realpath(__file__)), "web")
except Exception as _e:
    print(f"[tenkstack_fetch] could not register the panel: {_e}")

# Where models are published. A server-side fetch of any URL a page names is
# a way into whatever this container can reach; these are the hosts the
# workflow templates actually point at.
ALLOWED_HOSTS = ("huggingface.co", "hf.co", "civitai.com", "github.com", "githubusercontent.com")

_jobs = {}
_lock = threading.Lock()
_queue = []
_wake = threading.Event()


def _allowed(url):
    try:
        parts = urllib.parse.urlparse(url)
    except ValueError:
        return False
    if parts.scheme != "https" or not parts.hostname:
        return False
    if os.environ.get("TENKSTACK_FETCH_ANY_HOST") == "1":
        return True
    host = parts.hostname.lower()
    return any(host == h or host.endswith("." + h) for h in ALLOWED_HOSTS)


def _safe_name(name):
    if not name or name.startswith(("/", "\\")) or "\x00" in name:
        return False
    return ".." not in name.replace("\\", "/").split("/")


def _target_dir(directory):
    """The folder a model of this kind is written to: the one named like
    the kind, else the first ComfyUI searches."""
    if directory not in folder_paths.folder_names_and_paths:
        return None
    paths = folder_paths.get_folder_paths(directory)
    if not paths:
        return None
    for p in paths:
        if os.path.basename(os.path.normpath(p)) == directory:
            return p
    return paths[0]


def _exists(directory, name):
    try:
        return folder_paths.get_full_path(directory, name) is not None
    except Exception:
        return False


def _key(m):
    return f"{m['directory']}/{m['name']}"


def _check(m):
    name, directory, url = m.get("name", ""), m.get("directory", ""), m.get("url", "")
    out = {"name": name, "directory": directory, "url": url}
    if not _safe_name(name) or _target_dir(directory) is None:
        out["state"] = "unsupported"
        out["reason"] = "ComfyUI 不認得這個資料夾或檔名"
    elif _exists(directory, name):
        out["state"] = "present"
    elif not url:
        out["state"] = "no-url"
        out["reason"] = "工作流程沒有附下載網址"
    elif not _allowed(url):
        out["state"] = "blocked"
        out["reason"] = "只從 Hugging Face、Civitai、GitHub 下載"
    else:
        out["state"] = "missing"
    with _lock:
        job = _jobs.get(_key(out))
    if job and out["state"] != "present":
        out["job"] = dict(job)
    return out


def _headers(url):
    headers = {"User-Agent": "TenkStack-ModelFetch/1"}
    host = urllib.parse.urlparse(url).hostname or ""
    token = None
    if host.endswith(("huggingface.co", "hf.co")):
        token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    elif host.endswith("civitai.com"):
        token = os.environ.get("CIVITAI_TOKEN") or os.environ.get("CIVITAI_API_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _fetch(job):
    target = os.path.join(_target_dir(job["directory"]), job["name"])
    part = target + ".part"
    os.makedirs(os.path.dirname(target), exist_ok=True)
    # A partial left by an earlier attempt is continued, not restarted: the
    # files run to tens of gigabytes.
    have = os.path.getsize(part) if os.path.exists(part) else 0
    headers = _headers(job["url"])
    if have:
        headers["Range"] = f"bytes={have}-"
    req = urllib.request.Request(job["url"], headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        if have and resp.status != 206:
            have = 0
        length = resp.headers.get("Content-Length")
        total = (int(length) + have) if length else 0
        with _lock:
            job.update(total=total, done=have, state="downloading")
        started, last_done, last_t = time.time(), have, time.time()
        with open(part, "ab" if have else "wb") as f:
            while True:
                if job.get("cancel"):
                    raise InterruptedError()
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                now = time.time()
                with _lock:
                    job["done"] += len(chunk)
                    if now - last_t >= 1:
                        job["rate"] = (job["done"] - last_done) / (now - last_t)
                        last_done, last_t = job["done"], now
    if job["total"] and os.path.getsize(part) != job["total"]:
        raise IOError("下載的大小跟伺服器說的不一樣，檔案不完整")
    os.replace(part, target)
    # The dropdowns read a cached listing; without this the new file is
    # invisible until the next restart.
    try:
        folder_paths.filename_list_cache.pop(job["directory"], None)
    except Exception:
        pass


def _worker():
    while True:
        _wake.wait()
        while True:
            with _lock:
                if not _queue:
                    _wake.clear()
                    break
                job = _queue.pop(0)
            try:
                _fetch(job)
                with _lock:
                    job.update(state="done", rate=0)
            except InterruptedError:
                with _lock:
                    job.update(state="cancelled", rate=0)
            except urllib.error.HTTPError as e:
                reason = {401: "需要登入權杖（HF_TOKEN / CIVITAI_TOKEN）", 403: "沒有權限，可能要先在網站上同意授權條款",
                          404: "網址找不到檔案"}.get(e.code, f"HTTP {e.code}")
                with _lock:
                    job.update(state="error", error=reason, rate=0)
            except Exception as e:
                with _lock:
                    job.update(state="error", error=str(e)[:300], rate=0)


threading.Thread(target=_worker, name="tenkstack-fetch", daemon=True).start()

routes = PromptServer.instance.routes


@routes.post("/tenkstack/models/check")
async def check(request):
    body = await request.json()
    return web.json_response([_check(m) for m in body.get("models", [])])


@routes.post("/tenkstack/models/download")
async def download(request):
    body = await request.json()
    queued = []
    for m in body.get("models", []):
        c = _check(m)
        if c["state"] != "missing":
            continue
        key = _key(c)
        with _lock:
            job = _jobs.get(key)
            if job and job["state"] in ("queued", "downloading"):
                continue
            job = {"name": c["name"], "directory": c["directory"], "url": c["url"],
                   "state": "queued", "done": 0, "total": 0, "rate": 0, "error": ""}
            _jobs[key] = job
            _queue.append(job)
        queued.append(key)
    _wake.set()
    return web.json_response({"queued": queued})


@routes.post("/tenkstack/models/cancel")
async def cancel(request):
    body = await request.json()
    with _lock:
        job = _jobs.get(f"{body.get('directory')}/{body.get('name')}")
        if job and job["state"] in ("queued", "downloading"):
            job["cancel"] = True
            if job in _queue:
                _queue.remove(job)
                job["state"] = "cancelled"
    return web.json_response({"ok": True})


@routes.get("/tenkstack/models/status")
async def status(request):
    with _lock:
        return web.json_response([dict(j, cancel=None) for j in _jobs.values()])
