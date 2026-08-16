"""Where everything lives.

These were absolute paths under one person's home directory, spread across
eleven modules, three of them spelling out the same models directory and two the
same config file. Nobody else could run the console and the owner could not move
anything, which is the same defect seen from two sides.

Every location is an environment variable with a default, and the defaults are
relative to `~` -- so the machine this was written on is unaffected while any
other user gets working paths without setting anything. Only a layout that
differs from the one below needs configuration.

The defaults describe an arrangement rather than a preference: llama-swap, the
models, llama.cpp, ComfyUI and Caddy sitting side by side under one directory.
That is what `CONSOLE_AI_DIR` names, and moving it moves everything derived from
it, which is the common case. The rest exist for a layout that is genuinely
scattered.

Nothing here creates directories. A missing one is a real condition the callers
already report -- ComfyUI not installed, no Caddy channels -- and quietly
creating an empty directory would turn "not set up" into "set up and empty",
which reads the same and is not.
"""

from __future__ import annotations

import os
from pathlib import Path


def _path(var: str, default: str | Path) -> Path:
    """One location, overridable, `~` expanded on both sides.

    The default is expanded too, so `~/ai` resolves against whoever is running
    rather than against whoever wrote it down.
    """
    return Path(os.environ.get(var) or default).expanduser()


# The directory the rest of the stack lives under.
AI_DIR = _path("CONSOLE_AI_DIR", "~/ai")

# The console's own state: the session signing key and the SQLite database
# holding accounts, API keys and saved conversations. Worth separating from the
# rest because it is the only thing here the console itself writes.
STATE_DIR = _path("CONSOLE_STATE_DIR", AI_DIR / "ai-console")
SESSION_KEY = STATE_DIR / "session.key"
DB_PATH = STATE_DIR / "console.sqlite"

# GGUF weights. Shared by the downloader, the config editor and the disk gauge,
# which is why it was written out three times.
MODELS_DIR = _path("CONSOLE_MODELS_DIR", AI_DIR / "models")

# llama-swap: its binary for the version panel, its config for the models page.
LLAMA_SWAP_DIR = _path("CONSOLE_LLAMA_SWAP_DIR", AI_DIR / "llama-swap")
LLAMA_SWAP_CONFIG = _path("CONSOLE_LLAMA_SWAP_CONFIG", LLAMA_SWAP_DIR / "config.yaml")
LLAMA_SWAP_BIN = _path("CONSOLE_LLAMA_SWAP_BIN", LLAMA_SWAP_DIR / "llama-swap")

# The llama.cpp checkout, read only to report which commit the source sits at.
LLAMA_CPP_DIR = _path("CONSOLE_LLAMA_CPP_DIR", AI_DIR / "llama.cpp")

# ComfyUI's working directory, holding storage-models/ and storage-user/.
COMFY_DIR = _path("CONSOLE_COMFYUI_DIR", AI_DIR / "comfyui")

# Caddy: the directory whose channel files the console switches on and off, and
# the binary it asks for a version. The binary is not under AI_DIR -- it is
# installed per-user, wherever that user put it.
CADDY_DIR = _path("CONSOLE_CADDY_DIR", AI_DIR / "caddy")
CADDY_BIN = _path("CONSOLE_CADDY_BIN", "~/.local/bin/caddy")

# oneAPI, for the version panel. Vendor-specific and system-wide rather than
# per-user, so it does not hang off AI_DIR. On a machine without Intel hardware
# it is simply absent and the panel omits the row.
ONEAPI_DIR = _path("CONSOLE_ONEAPI_DIR", "/opt/intel/oneapi")
