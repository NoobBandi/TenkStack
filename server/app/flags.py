"""The launch flags a binary actually has, read from the binary.

Both places the console offers a choice of flags used to offer a list written
into the source. That is fine on the machine it was written on and wrong
everywhere else: llama.cpp's flags move between builds -- this one's help names
five that have been removed outright -- and somebody else's install is a
different version, a different backend, sometimes a different program. A list
baked into the interface would hand them a flag their build does not have, the
server would refuse to start, and nothing on screen would connect the two.

So the list is asked for. `--help` is a stable, documented interface that every
one of these programs has, it prints its own flags with its own descriptions and
its own grouping, and whatever it says is true of the thing that is installed.

Parsed rather than shown raw because the interface needs the parts separately:
which names are aliases of each other, whether a flag takes a value, what it is
for. The output is regular enough for that -- flags start at column zero,
descriptions at column forty and wrap there, groups are `----- name -----` --
and a line that does not parse is dropped rather than guessed at.
"""

from __future__ import annotations

import asyncio
import logging
import re
import shlex
from dataclasses import dataclass, asdict
from pathlib import Path

from . import containers, paths

logger = logging.getLogger(__name__)

# Long enough for a cold binary on a slow disk, short enough that a program
# which does not answer `--help` does not hold a request open.
_TIMEOUT = 20

_GROUP = re.compile(r"^-{3,}\s*(.+?)\s*-{3,}$")
_NAME = re.compile(r"-{1,2}[A-Za-z0-9][\w.-]*")
# A flag takes a value when its head ends in a placeholder rather than in the
# flag itself: `N`, `FNAME`, `<0|1>`, `MODE`.
_TAKES_VALUE = re.compile(r"(?:[A-Z][\w-]*|<[^>]+>|\[[^\]]+\])\s*$")


@dataclass
class Flag:
    """One switch, as its own program describes it."""
    names: list[str]
    group: str
    help: str
    takes_value: bool


def _help_column(lines: list[str]) -> int:
    """Where this program starts its descriptions.

    Measured rather than assumed. llama.cpp pads its names out to column 40 and
    argparse -- which is what ComfyUI uses -- pads to 24, and a column hardcoded
    for one silently mangles the other: 32 of ComfyUI's flags came back with an
    empty description and one with only the tail of its second line, because the
    split landed in the middle of the sentence and the first half went into the
    names.

    Found by looking at where a description actually begins on lines that have
    one, and taking the column that happens most. Wrapped continuation lines are
    indented to the same place, so they vote for it too, which is what makes the
    answer clear rather than close.
    """
    votes: dict[int, int] = {}
    for line in lines:
        if not line.startswith((" ", "-")) or not line.strip().startswith("-"):
            continue
        # The gap after the names: two or more spaces, then the description.
        match = re.search(r"\S(\s{2,})\S", line)
        if match:
            column = match.end() - 1
            votes[column] = votes.get(column, 0) + 1
    if not votes:
        return 40
    return max(votes.items(), key=lambda kv: kv[1])[0]


def _split(line: str, column: int) -> tuple[str, str]:
    """A flag line into its names and its description."""
    if len(line) > column and line[column - 1] == " ":
        return line[:column], line[column:].strip()
    # A name list long enough to run past the column pushes its description onto
    # the next line, which arrives as a continuation.
    return line, ""


def parse(text: str) -> list[Flag]:
    """`--help` output to flags.

    Continuation lines are joined into the description they belong to, which is
    what makes a wrapped sentence readable in a dropdown rather than a fragment
    ending mid-word.
    """
    out: list[Flag] = []
    group = ""
    current: Flag | None = None
    lines = text.splitlines()
    column = _help_column(lines)

    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            continue

        heading = _GROUP.match(line.strip())
        if heading:
            group = heading.group(1)
            current = None
            continue

        starts_flag = line.startswith("-") or (
            line.startswith("  ") and not line.startswith("    ")
            and line.strip().startswith("-"))
        if starts_flag:
            head, tail = _split(line, column)
            names = _NAME.findall(head)
            if not names:
                current = None
                continue
            current = Flag(
                names=names,
                group=group,
                help=tail.strip(),
                takes_value=bool(_TAKES_VALUE.search(head.rstrip())),
            )
            out.append(current)
        elif current is not None:
            current.help = f"{current.help} {line.strip()}".strip()

    for flag in out:
        # `(env: LLAMA_ARG_CTX_SIZE)` is true and useless here: this is a
        # dropdown of command-line switches, and the reader is picking one to
        # write on a command line.
        flag.help = re.sub(r"\s*\(env: [A-Z_0-9]+\)", "", flag.help).strip()
    return out


async def _run(argv: list[str], env: dict[str, str] | None = None) -> str | None:
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=env,
        )
        raw, _ = await asyncio.wait_for(proc.communicate(), timeout=_TIMEOUT)
    except (OSError, asyncio.TimeoutError):
        logger.exception("could not ask %s for its flags", argv[0])
        return None
    return raw.decode("utf-8", "replace")


# Read once per binary, keyed on the path and how new it is: a rebuilt
# llama-server is a different set of flags under the same name, and the mtime is
# what says so without running it again on every request.
_CACHE: dict[tuple[str, float], list[Flag]] = {}


async def llama_server() -> list[Flag]:
    """What the installed llama-server takes.

    Run through the same wrapper llama-swap uses, because a SYCL build needs
    oneAPI's runtime on its library path and will not start without it -- asking
    the binary directly gets a linker error rather than a help page.
    """
    binary = paths.LLAMA_SWAP_DIR / "llama-server-sycl.sh"
    if not binary.exists():
        binary = paths.LLAMA_CPP_DIR / "builds" / "current" / "bin" / "llama-server"
    if not binary.exists():
        return []

    try:
        stamp = binary.stat().st_mtime
    except OSError:
        return []
    key = (str(binary), stamp)
    if key in _CACHE:
        return _CACHE[key]

    argv = ([str(binary)] if binary.suffix == ".sh"
            else [str(binary)]) + ["--help"]
    text = await _run(argv)
    flags = parse(text) if text else []
    if flags:
        _CACHE[key] = flags
    return flags


async def comfyui(container: str) -> list[Flag]:
    """What the ComfyUI in one container takes.

    Asked of the container rather than of a table here, for the same reason: the
    image is somebody's choice and a different one has different flags. Keyed on
    the container's image id, so pulling a new image asks again and restarting
    the same one does not.
    """
    detail = await containers._inspect([container])
    image = ((detail.get(container) or {}).get("Image")) or container
    key = (f"comfyui:{image}", 0.0)
    if key in _CACHE:
        return _CACHE[key]

    text = await _run([
        "docker", "exec", container, "sh", "-lc",
        "cd /root/ComfyUI && python main.py --help",
    ])
    flags = parse(text) if text else []
    if flags:
        _CACHE[key] = flags
    return flags


# A flag whose whole job is to print something and stop.
#
# `--cache-list` shows what is in the model cache, `--list-devices` enumerates
# GPUs, `--version` says the version. Put any of them in a model's launch
# arguments and the server prints its line and exits instead of serving -- they
# are actions, not configuration, and they have no business in a field whose
# only purpose is configuring a long-running process.
#
# Matched on the program's own first word rather than on a list of names kept
# here, for the same reason the flags are read from the binary at all: llama.cpp
# has five and every one says outright that it shows, prints or lists. A sixth
# added upstream tomorrow is caught by the same sentence.
_ACTION = re.compile(r"^(show|print|list|display)\b", re.I)


def is_action(flag: Flag) -> bool:
    return bool(_ACTION.match(flag.help))


def as_dicts(flags: list[Flag]) -> list[dict]:
    """For the interface: what can be configured, without what merely reports."""
    return [asdict(f) for f in flags if not is_action(f)]


def quote(value: str) -> str:
    """A value as it would be written on a command line."""
    return shlex.quote(value)
