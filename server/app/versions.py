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

from . import gpu, llamaswap
from . import paths

logger = logging.getLogger(__name__)

LLAMA_SWAP_BIN = paths.LLAMA_SWAP_BIN
CADDY_BIN = paths.CADDY_BIN
LLAMA_CPP_DIR = paths.LLAMA_CPP_DIR
ONEAPI_DIR = paths.ONEAPI_DIR
COMFYUI_URL = "http://127.0.0.1:8188"


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


async def collect() -> list[dict]:
    (swap, caddy, cpp_src, cpp_run, comfy, device) = await asyncio.gather(
        _llama_swap(), _caddy(), _llama_cpp_source(), _llama_cpp_running(),
        _comfyui(), gpu.detail(0),
    )
    raw = (device or {}).get("raw", {})

    groups = [
        ("推論", [
            ("llama.cpp（執行中）", cpp_run),
            ("llama.cpp（原始碼）", cpp_src),
            ("llama-swap", swap),
        ]),
        ("圖像生成", [
            ("ComfyUI", comfy.get("ComfyUI")),
            ("PyTorch", comfy.get("PyTorch")),
            ("Python", comfy.get("Python")),
        ]),
        ("驅動與執行環境", [
            ("GPU 驅動", raw.get("driver_version")),
            ("核心", raw.get("kernel_version")),
            ("oneAPI", _oneapi()),
            ("韌體", raw.get("gfx_firmware_status")),
        ]),
        ("服務", [
            ("Caddy", caddy),
        ]),
    ]

    return [
        {"title": title,
         # A missing probe is shown as unknown rather than omitted: the absence
         # of a component is itself worth seeing.
         "rows": [{"label": label, "value": value or "—"} for label, value in rows]}
        for title, rows in groups
    ]
