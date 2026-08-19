"""Which ways in are open, and from which networks.

Each optional channel is one Caddy site block in its own file under
`caddy/channels/`. Two independent things are controlled here:

  * whether the channel exists at all -- the file sits in `channels/` when on,
    and in `channels/disabled/` when off;
  * which networks may reach it -- a `bind` directive, generated into
    `channels/binds/<name>.bind` and imported from inside the block.

`bind` is used rather than hostname matching because it is an actual boundary:
Caddy opens a socket only on the addresses listed, so a channel restricted to
the LAN has nothing listening on the Tailscale address at all. Matching on the
Host header would leave the port open and answer 404, which is a different and
much weaker statement.

Addresses are resolved when the file is written rather than stored, because a
DHCP lease change would otherwise leave a literal address in the config that
Caddy cannot bind, and it would refuse to start.

The console's own site is deliberately not one of these. It stays in the main
Caddyfile, outside the import, so that nothing here can take away the interface
that holds the switches.

Applying a change restarts Caddy rather than reloading it: `caddy reload` talks
to the admin API on :2019, and this deployment sets `admin off`, so a reload can
only ever fail.
"""

from __future__ import annotations

import asyncio
import logging
import re
import shutil
import socket
import subprocess
from pathlib import Path
from . import paths

logger = logging.getLogger(__name__)

CADDY_DIR = paths.CADDY_DIR
CADDYFILE = CADDY_DIR / "Caddyfile"
CHANNELS = CADDY_DIR / "channels"
DISABLED = CHANNELS / "disabled"
BINDS = CHANNELS / "binds"
CADDY_BIN = Path.home() / ".local/bin/caddy"

LOOPBACK = "127.0.0.1"

_META = {
    "api-http": {
        "label": "API（純 HTTP）",
        "port": 8000,
        "encrypted": False,
        "note": "給不方便信任自簽憑證的用戶端，例如 Opencode。只開放 /v1，"
                "API key 在區網上是明文傳送。",
    },
    "comfyui": {
        "label": "ComfyUI",
        "port": 8444,
        "encrypted": True,
        "note": "圖像生成介面，經主控台登入驗證後才放行。",
    },
}

# Scope key -> how to find the address it stands for.
SCOPES = ("lan", "tailscale", "wan")


def _addresses() -> dict[str, str | None]:
    """The address behind each scope, right now.

    LAN is taken from whichever interface carries the default route, so a
    machine that changes NIC or subnet keeps working without anyone editing a
    config file.
    """
    lan = None
    tailscale = None

    try:
        out = subprocess.run(
            ["ip", "-4", "-o", "addr", "show"],
            capture_output=True, text=True, timeout=5,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        out = ""

    default_iface = None
    try:
        route = subprocess.run(
            ["ip", "-4", "route", "show", "default"],
            capture_output=True, text=True, timeout=5,
        ).stdout.split()
        if "dev" in route:
            default_iface = route[route.index("dev") + 1]
    except (OSError, subprocess.SubprocessError, ValueError):
        pass

    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        iface, address = parts[1], parts[3].split("/")[0]
        if iface.startswith("tailscale"):
            tailscale = address
        elif default_iface and iface == default_iface:
            lan = address

    return {"lan": lan, "tailscale": tailscale, "wan": "0.0.0.0"}


def _bind_path(name: str) -> Path:
    return BINDS / f"{name}.bind"


def _read_scopes(name: str) -> set[str]:
    """Which scopes the current bind file expresses.

    A missing or empty file means no `bind` directive at all, which is Caddy's
    default of listening everywhere -- reported as `wan`, since that is what it
    actually does.
    """
    try:
        text = _bind_path(name).read_text().strip()
    except OSError:
        return {"wan"}
    if not text:
        return {"wan"}

    listed = set(text.split()[1:]) if text.startswith("bind") else set()
    if "0.0.0.0" in listed:
        return {"wan"}

    current = _addresses()
    scopes = set()
    for scope in ("lan", "tailscale"):
        address = current.get(scope)
        if address and address in listed:
            scopes.add(scope)
    return scopes


def _write_scopes(name: str, scopes: set[str]) -> None:
    BINDS.mkdir(parents=True, exist_ok=True)
    path = _bind_path(name)

    if "wan" in scopes:
        # Every interface, including any the router forwards a port to. Written
        # as an explicit bind rather than an empty file so the intent is legible
        # in the config itself.
        path.write_text("bind 0.0.0.0\n")
        return

    current = _addresses()
    # Loopback always: the host itself must be able to reach its own services,
    # and dropping it would break anything on this machine that uses the port.
    listed = [LOOPBACK]
    for scope in ("lan", "tailscale"):
        if scope in scopes and current.get(scope):
            listed.append(current[scope])
    path.write_text(f"bind {' '.join(listed)}\n")


# A site address line: `https://host:8444, https://127.0.0.1:8444,` or a bare
# `http://:8000 {`. Anchored to the start of a line so the ports inside
# `reverse_proxy 127.0.0.1:8070` and prose in comments are not mistaken for
# published ones.
_ADDRESS_LINE = re.compile(r"^\s*https?://\S", re.M)
_PORT = re.compile(r":(\d+)")


def _published(path: Path | None) -> list[int]:
    """The ports a channel file actually opens.

    Read rather than declared, because one channel is no longer one port. The
    ComfyUI channel is a site block per instance -- 8444 for the first card,
    8445 for the second -- and the console can now add them, so a table saying
    `:8444` beside a switch that governs both was describing a machine that
    stopped existing today.
    """
    if path is None:
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    found: set[int] = set()
    for line in text.splitlines():
        if _ADDRESS_LINE.match(line):
            found.update(int(port) for port in _PORT.findall(line))
    return sorted(found)


def status() -> list[dict]:
    files: dict[str, Path] = {}
    for directory in (CHANNELS, DISABLED):
        if directory.is_dir():
            for path in directory.glob("*.caddy"):
                files.setdefault(path.stem, path)

    addresses = _addresses()
    out = []
    for name, meta in _META.items():
        path = files.get(name)
        published = _published(path)
        out.append({
            "key": name,
            "enabled": path is not None and path.parent == CHANNELS,
            "present": path is not None,
            "scopes": sorted(_read_scopes(name)),
            # Every port, from the file. `port` stays as the one the rest of
            # the console links to.
            "ports": published or ([meta["port"]] if meta.get("port") else []),
            **meta,
        })
    return {"channels": out, "addresses": addresses}  # type: ignore[return-value]


async def _run(*args: str, timeout: float = 60.0) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        return 1, f"{args[0]} timed out"
    return proc.returncode or 0, out.decode(errors="replace")


async def _apply(rollback) -> None:
    """Validate, reload, and undo the change if either step fails.

    Reload rather than restart. A restart drops every open connection, and this
    is the gateway: the console's own SSE stream goes with it, and so does any
    ComfyUI websocket carrying the progress of a job that is still running.
    Toggling a channel is a change to who may reach what, and it should not
    interrupt what is already happening.

    This became possible when the admin endpoint moved from `off` to a unix
    socket. Before that `caddy reload` could only fail -- it drives the admin
    API -- so a restart was the only way to apply anything.
    """
    code, output = await _run(str(CADDY_BIN), "validate",
                              "--config", str(CADDYFILE), "--adapter", "caddyfile")
    if code != 0:
        rollback()
        logger.error("caddy validate rejected the change: %s", output[-400:])
        raise RuntimeError(f"設定驗證失敗，已還原：{output.strip()[-200:]}")

    code, output = await _run("systemctl", "--user", "reload", "caddy")
    if code != 0:
        rollback()
        # Reload the rolled-back config so the running Caddy matches the files
        # again. If that also fails, a restart is the last thing that always
        # works, downtime and all.
        if (await _run("systemctl", "--user", "reload", "caddy"))[0] != 0:
            await _run("systemctl", "--user", "restart", "caddy")
        raise RuntimeError(f"Caddy 重新載入失敗，已還原：{output.strip()[-200:]}")


async def set_enabled(name: str, enabled: bool):
    if name not in _META:
        raise KeyError(name)

    path = None
    for directory in (CHANNELS, DISABLED):
        candidate = directory / f"{name}.caddy"
        if candidate.exists():
            path = candidate
            break
    if path is None:
        raise FileNotFoundError(f"{name}.caddy is missing from {CHANNELS}")

    target_dir = CHANNELS if enabled else DISABLED
    if path.parent == target_dir:
        return {"changed": False, **status()}

    DISABLED.mkdir(parents=True, exist_ok=True)
    destination = target_dir / path.name
    shutil.move(str(path), str(destination))

    await _apply(lambda: shutil.move(str(destination), str(path)))
    logger.info("channel %s %s", name, "enabled" if enabled else "disabled")
    return {"changed": True, **status()}


async def set_scopes(name: str, scopes: list[str]):
    if name not in _META:
        raise KeyError(name)
    wanted = {s for s in scopes if s in SCOPES}

    path = _bind_path(name)
    previous = path.read_text() if path.exists() else None

    def rollback() -> None:
        if previous is None:
            path.unlink(missing_ok=True)
        else:
            path.write_text(previous)

    _write_scopes(name, wanted)
    await _apply(rollback)
    logger.info("channel %s scopes -> %s", name, sorted(wanted) or ["local"])
    return {"changed": True, **status()}


# --------------------------------------------------------------------------
# Publishing one ComfyUI instance
#
# The ComfyUI channel is one site block per instance, mapped by a fixed offset:
# 8188 is published on 8444, 8189 on 8445. That was a comment describing what
# somebody did by hand; creating an instance from the console means doing it
# from here instead, or a new card ends up with an instance the household
# cannot reach.
#
# The hosts are copied from a block that already exists rather than rebuilt,
# because that list is the machine's own answer to "what am I called" --
# hostname, LAN address, Tailscale name and address -- and reconstructing it
# would be a second, worse copy of it. Only the first instance on a fresh
# machine has nothing to copy, and that one is built from what `_addresses`
# already finds.
# --------------------------------------------------------------------------

COMFYUI_CHANNEL = "comfyui.caddy"
UPSTREAM_BASE = 8188
PUBLIC_BASE = 8444

_SITE = re.compile(
    r"\n#[^\n]*\n(?:https://[^\n]*\n)*[^\n]*\{\n\timport comfyui-channel (\d+)\n\}\n"
)
_HOST = re.compile(r"https://([^:,\s]+):\d+")


def public_port(upstream: int) -> int:
    return PUBLIC_BASE + (upstream - UPSTREAM_BASE)


def _channel_path() -> Path | None:
    for directory in (CHANNELS, DISABLED):
        path = directory / COMFYUI_CHANNEL
        if path.exists():
            return path
    return None


def _hosts(text: str) -> list[str]:
    """The names this machine publishes under, from the file or from the box."""
    found = list(dict.fromkeys(_HOST.findall(text)))
    if found:
        return found

    addresses = _addresses()
    names = ["localhost", "127.0.0.1", socket.gethostname()]
    for key in ("lan", "tailscale"):
        if addresses.get(key):
            names.append(addresses[key])
    return list(dict.fromkeys(names))


async def publish_comfyui(upstream: int, note: str = "") -> int:
    """Add a site block for one instance, and reload. Returns the public port."""
    path = _channel_path()
    if path is None:
        raise RuntimeError(f"找不到 {COMFYUI_CHANNEL}，無法發布這個實例")

    text = path.read_text(encoding="utf-8")
    if f"import comfyui-channel {upstream}\n" in text:
        return public_port(upstream)

    port = public_port(upstream)
    addresses = ",\n".join(f"https://{host}:{port}" for host in _hosts(text))
    block = (
        f"\n# :{upstream}{f' -- {note}' if note else ''}\n"
        f"{addresses} {{\n\timport comfyui-channel {upstream}\n}}\n"
    )

    before = text
    path.write_text(text.rstrip("\n") + "\n" + block, encoding="utf-8")
    await _apply(lambda: path.write_text(before, encoding="utf-8"))
    logger.info("published ComfyUI :%d on :%d", upstream, port)
    return port


async def unpublish_comfyui(upstream: int) -> None:
    """Remove one instance's site block, and reload."""
    path = _channel_path()
    if path is None:
        return
    text = path.read_text(encoding="utf-8")
    trimmed = _SITE.sub(
        lambda m: "" if m.group(1) == str(upstream) else m.group(0), text)
    if trimmed == text:
        return
    path.write_text(trimmed, encoding="utf-8")
    await _apply(lambda: path.write_text(text, encoding="utf-8"))
    logger.info("unpublished ComfyUI :%d", upstream)
