"""Every port this console assumes, in one place.

The same argument `paths` makes for directories. A port is a fact about how this
machine was set up, not a property of the code, and writing one into three
modules means the third is wrong the first time somebody moves it.

They were written into several. `range(8188, 8192)` appeared in `comfy`, in
`main` and in `versions`; the ComfyUI public-port offset appeared in `channels`
as a pair of bases, in `main` as their subtraction, and a third time in the web
interface as the same arithmetic spelled out again. Nothing kept them in step
and nothing would have said which was authoritative.

Every entry is an environment variable with a default, and the defaults are what
this machine runs, so an install that follows the usual layout sets nothing.
"""

from __future__ import annotations

import os


def _port(var: str, default: int) -> int:
    raw = os.environ.get(var)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    # Out-of-range is a typo, not a choice: falling back beats binding to
    # something arbitrary and failing later with a confusing error.
    return value if 1 <= value <= 65535 else default


# Where llama-swap answers. The console proxies /v1 to it and reads its
# /running, /api/events and log stream from here.
LLAMA_SWAP = _port("CONSOLE_LLAMA_SWAP_PORT", 8080)

# The console's own backend, behind Caddy.
CONSOLE = _port("CONSOLE_PORT", 8070)

# What Caddy publishes.
#
# `API` is the plain-HTTP /v1 for clients that will not accept a private CA;
# `CONSOLE_TLS` is everything else, the interface and the encrypted /v1 both.
API = _port("CONSOLE_API_PORT", 8000)
CONSOLE_TLS = _port("CONSOLE_TLS_PORT", 8443)

# ComfyUI: the loopback ports its containers publish on, and where Caddy
# republishes them.
#
# A range rather than a list because the containers are created by this console
# and take the first free one; the width is how many instances a machine may
# have, which is one per card plus room to be wrong about that.
COMFYUI_FIRST = _port("CONSOLE_COMFYUI_PORT", 8188)
COMFYUI_COUNT = _port("CONSOLE_COMFYUI_COUNT", 4)
COMFYUI_PORTS = tuple(range(COMFYUI_FIRST, COMFYUI_FIRST + COMFYUI_COUNT))

# The public side of the same instances. Derived by offset rather than listed,
# because a site block is written per instance and the offset is what decides
# its address.
COMFYUI_PUBLIC_FIRST = _port("CONSOLE_COMFYUI_PUBLIC_PORT", 8444)


def comfyui_public(upstream: int) -> int:
    """The port Caddy serves one instance on, from the port it publishes."""
    return COMFYUI_PUBLIC_FIRST + (upstream - COMFYUI_FIRST)
