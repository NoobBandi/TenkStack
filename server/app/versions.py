"""What is actually installed and running.

Every component here reports its version somewhere different — a CLI flag, an
HTTP endpoint, a directory name, a git hash. Collecting them in one place is
the difference between "the SYCL build" and knowing exactly which commit is
serving requests when something starts behaving differently.

Each probe fails independently: one stopped service must not blank the page.
"""

from __future__ import annotations

import asyncio
import logging
import re

import httpx

from . import gpu, llamaswap, ports
from . import paths

logger = logging.getLogger(__name__)

LLAMA_SWAP_BIN = paths.LLAMA_SWAP_BIN
CADDY_BIN = paths.CADDY_BIN
LLAMA_CPP_DIR = paths.LLAMA_CPP_DIR
ONEAPI_DIR = paths.ONEAPI_DIR
# Where ComfyUI might be, rather than where it is. One instance per card means
# the port that answers is whichever instances are up, and asking a fixed one
# reported every version as unknown the moment that card was switched off.
COMFYUI_PORTS = ports.COMFYUI_PORTS


async def _run(*args: str, timeout: float = 5.0) -> str | None:
    try:
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except (FileNotFoundError, asyncio.TimeoutError, PermissionError):
        return None
    return stdout.decode(errors="replace").strip() or None


async def _llama_swap() -> str | None:
    out = await _run(str(LLAMA_SWAP_BIN), "--version")
    if not out:
        return None
    # "version: v247 (40027d6), built at ..."
    match = re.search(r"(v[\d.]+)\s*\(([0-9a-f]+)\)", out)
    return f"{match.group(1)} ({match.group(2)})" if match else out.splitlines()[0]


async def _caddy() -> str | None:
    out = await _run(str(CADDY_BIN), "version")
    return out.split()[0] if out else None


async def _llama_cpp_source() -> str | None:
    out = await _run("git", "-C", str(LLAMA_CPP_DIR), "log", "-1", "--format=%h (%ad)", "--date=short")
    return out


async def _llama_cpp_running() -> str | None:
    """The build actually serving requests, which need not match the checkout."""
    running = await llamaswap.get_running()
    proxy = next((r.get("proxy") for r in running if r.get("proxy")), None)
    if not proxy:
        return None
    props = await llamaswap.get_props(proxy)
    return (props or {}).get("build_info")


async def _llama_cpp_installed() -> list[dict]:
    """What each configured launcher would run, asked of the binary itself.

    `--version` rather than the build string from a loaded model: no model is
    loaded most of the time, and this row spent most of its life reading `—` as
    a result. It also reaches a launcher that has never served anything, which
    is exactly when you want to know what it is.
    """
    from . import config

    out = []
    for name, path in config.launcher_macros().items():
        text = await _run(path, "--version", timeout=90)
        if not text:
            continue
        version = next((line for line in text.splitlines()
                        if line.startswith("version:")), "")
        built = next((line for line in text.splitlines()
                      if line.startswith("built with")), "")
        out.append({
            "launcher": name,
            "version": version.removeprefix("version:").strip() or text.splitlines()[0],
            "built": built.removeprefix("built with").strip(),
        })
    return out


async def _comfyui_instances() -> list[dict]:
    """Every ComfyUI that answers, with the stack inside it.

    Reported per instance rather than once, because the instances differ in the
    thing being reported: the Arc's runs PyTorch for XPU and the NVIDIA card's
    runs a CUDA build. One number for both would be true of one of them.
    """
    async def probe(port: int) -> dict | None:
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}",
                                     timeout=3) as client:
            try:
                resp = await client.get("/system_stats")
                resp.raise_for_status()
            except httpx.HTTPError:
                return None
        system = resp.json().get("system", {})
        devices = resp.json().get("devices") or []
        return {
            "port": port,
            "device": (devices[0].get("name") if devices else "") or "",
            "comfyui": system.get("comfyui_version"),
            "pytorch": system.get("pytorch_version"),
            "python": (system.get("python_version") or "").split()[0] or None,
        }

    found = await asyncio.gather(*(probe(port) for port in COMFYUI_PORTS))
    return [instance for instance in found if instance]


def _oneapi() -> str | None:
    if not ONEAPI_DIR.is_dir():
        return None
    versions = sorted(
        (p.name for p in ONEAPI_DIR.iterdir() if re.fullmatch(r"20\d\d\.\d+", p.name)),
        reverse=True,
    )
    return versions[0] if versions else None


async def _comfyui() -> dict:
    async with httpx.AsyncClient(base_url=COMFYUI_URL, timeout=3) as client:
        try:
            resp = await client.get("/system_stats")
            resp.raise_for_status()
        except httpx.HTTPError:
            return {}
    system = resp.json().get("system", {})
    return {
        "ComfyUI": system.get("comfyui_version"),
        "PyTorch": system.get("pytorch_version"),
        "Python": (system.get("python_version") or "").split()[0] or None,
    }


async def collect() -> dict:
    """Everything installed, grouped the way it is actually arranged.

    Version drift is the usual explanation when something that worked yesterday
    does not today, and every component here reports itself somewhere
    different. The shape follows the machine rather than a flat list: llama.cpp
    appears as one row per launcher because there can be one per vendor, and
    ComfyUI as one row per instance because the instances differ in exactly the
    thing being reported -- the Arc's runs PyTorch for XPU, the NVIDIA card's a
    CUDA build.
    """
    swap, caddy, source, running, launchers, instances, device = await asyncio.gather(
        _llama_swap(), _caddy(), _llama_cpp_source(), _llama_cpp_running(),
        _llama_cpp_installed(), _comfyui_instances(), gpu.detail(0),
    )
    raw = (device or {}).get("raw", {})

    return {
        "inference": {
            "launchers": launchers,
            # The build serving right now, when something is loaded. It can
            # differ from what the launcher reports if the binary was replaced
            # under a running server.
            "running": running,
            "source": source,
            "swap": swap,
        },
        "comfyui": instances,
        "system": [
            {"label": label, "value": value}
            for label, value in (
                ("GPU 驅動", raw.get("driver_version")),
                ("核心", raw.get("kernel_version")),
                ("oneAPI", _oneapi()),
                ("韌體", raw.get("gfx_firmware_status")),
                ("Caddy", caddy),
            ) if value
        ],
    }
