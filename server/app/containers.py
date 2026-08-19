"""The containers this platform runs on, and which card each one holds.

Everything here is derived, never declared. There is no list of expected
containers and no row per vendor, because the machine this runs on is not the
only shape it will ever have: a host with no Intel card, or no NVIDIA card, or
two of one and none of the other, must produce a page that is right without
anyone editing a table first.

That principle is already how ComfyUI instances are found -- probed, not
configured, because a listed-but-absent instance is wrong in both directions --
and it applies with more force here. The pairing between a container and a card
is read from the container's own device bindings rather than from its name:
`comfyui-xpu` and `comfyui-nv0` are a convention, and a convention is a thing
somebody can rename. `--device /dev/dri/renderD128` and a CUDA device request
are facts.

Four situations follow from that, and each has to say something different:

  * container and card both present -- the ordinary row.
  * container present, its card gone -- the one worth shouting about. The
    restart policy is `unless-stopped`, so Docker keeps starting it, and it
    either fails or quietly falls back to the CPU. Nothing else on the machine
    would explain why images stopped appearing.
  * card present with no container -- said, not offered. Creating one is
    `docker run`, which is the verb this module deliberately does not have.
  * neither -- the page says the platform has no image runtime at all, rather
    than drawing an empty table.

What this module can do is list and restart. It cannot create, exec into, or
remove a container. That line is where the risk is: `restart` re-runs a
configuration that already exists and that somebody with access to this machine
already chose, while `run` and `exec` are indistinguishable from a root shell,
because the console's own user is in the `docker` group.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)

DRM_CLASS = Path("/sys/class/drm")


async def _docker(*args: str) -> str | None:
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker", *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except OSError:
        return None
    out, err = await proc.communicate()
    if proc.returncode != 0:
        logger.warning("docker %s failed: %s", args[0], err.decode().strip()[:200])
        return None
    return out.decode()


def bus_key(address: str) -> str:
    """A PCI address in the form two sources can be compared in.

    The kernel writes four domain digits and lower case; nvidia-smi writes eight
    and upper. The domain is dropped and the rest folded down.
    """
    return ":".join(address.strip().lower().split(":")[-2:])


def _pci_for_render(node: str) -> str | None:
    """The card behind /dev/dri/renderD128, as a PCI address.

    The device node is the only thing the container declares, and it is not a
    stable name -- render node numbering is probe order. Resolving it through
    sysfs turns it into the one identifier the GPU providers also report.
    """
    try:
        return (DRM_CLASS / node / "device").resolve().name
    except OSError:
        return None


async def _inspect(names: list[str]) -> dict[str, dict]:
    if not names:
        return {}
    raw = await _docker("inspect", *names)
    if not raw:
        return {}
    try:
        return {entry["Name"].lstrip("/"): entry for entry in json.loads(raw)}
    except (ValueError, KeyError, TypeError):
        logger.warning("could not parse docker inspect output")
        return {}


def _claimed_cards(host: dict, devices: list[dict]) -> tuple[list[str], bool]:
    """(PCI addresses this container asked for, whether it asked for a GPU).

    The two vendors ask in different ways and both have to be read. Intel and
    AMD pass a render node straight through as a device; NVIDIA goes through
    its container toolkit, which arrives as a device *request* naming CUDA
    ordinals -- or nothing at all, which means every card.
    """
    wants = False
    claimed: list[str] = []

    for entry in host.get("Devices") or []:
        path = str(entry.get("PathOnHost") or "")
        if not path.startswith("/dev/dri/render"):
            continue
        wants = True
        address = _pci_for_render(Path(path).name)
        if address:
            claimed.append(address)

    for request in host.get("DeviceRequests") or []:
        if not any("gpu" in group for group in (request.get("Capabilities") or [])):
            continue
        wants = True
        ordinals = request.get("DeviceIDs") or []
        nvidia = [d for d in devices if d.get("vendor") == "nvidia"]
        if not ordinals or "all" in ordinals:
            claimed += [d["pci_bdf_address"] for d in nvidia if d.get("pci_bdf_address")]
            continue
        for wanted in ordinals:
            text = str(wanted)
            if text.isdigit():
                # A CUDA ordinal counts NVIDIA cards and nothing else, while the
                # console numbers every card in the machine -- so the `0` in the
                # request is not the `index` of the console's first device. It
                # is a position within the NVIDIA cards, in the order the
                # provider found them.
                if int(text) < len(nvidia) and nvidia[int(text)].get("pci_bdf_address"):
                    claimed.append(nvidia[int(text)]["pci_bdf_address"])
                continue
            for device in nvidia:
                if text in str((device.get("raw") or {}).get("uuid") or ""):
                    if device.get("pci_bdf_address"):
                        claimed.append(device["pci_bdf_address"])

    return claimed, wants


async def survey(devices: list[dict]) -> dict:
    """Every container on this machine, paired with the cards it holds.

    `devices` is the GPU list the console already has, passed in rather than
    fetched so this does not probe the cards a second time on every poll.
    """
    listing = await _docker("ps", "-a", "--format", "{{json .}}")
    if listing is None:
        return {"available": False, "containers": [], "idle_gpus": []}

    rows = []
    for line in listing.splitlines():
        try:
            rows.append(json.loads(line))
        except ValueError:
            continue

    details = await _inspect([row.get("Names", "") for row in rows if row.get("Names")])
    by_bus = {
        bus_key(str(d["pci_bdf_address"])): d
        for d in devices if d.get("pci_bdf_address")
    }

    held: set[str] = set()
    containers = []
    for row in rows:
        name = row.get("Names", "")
        detail = details.get(name) or {}
        host = detail.get("HostConfig") or {}
        claimed, wants = _claimed_cards(host, devices)

        cards = []
        for address in claimed:
            device = by_bus.get(bus_key(address))
            if device:
                held.add(bus_key(address))
                cards.append({
                    "pci_bdf_address": device["pci_bdf_address"],
                    "name": device.get("name"),
                    "vendor": device.get("vendor"),
                })

        containers.append({
            "name": name,
            "image": row.get("Image"),
            "state": row.get("State"),
            "status": row.get("Status"),
            "ports": row.get("Ports") or "",
            "created": row.get("CreatedAt"),
            "restart_policy": ((host.get("RestartPolicy") or {}).get("Name") or "no"),
            "wants_gpu": wants,
            "cards": cards,
            # The case worth shouting about: it was given a card that is not in
            # this machine any more. Docker will keep starting it regardless.
            "orphaned": wants and not cards,
        })

    containers.sort(key=lambda row: row["name"])
    return {
        "available": True,
        "containers": containers,
        # Said, not offered. A card with nothing on it is worth knowing about;
        # creating the container that would use it is not this module's job.
        "idle_gpus": [
            {"pci_bdf_address": d["pci_bdf_address"], "name": d.get("name"),
             "vendor": d.get("vendor")}
            for d in devices
            if d.get("pci_bdf_address") and bus_key(str(d["pci_bdf_address"])) not in held
        ],
    }


# `127.0.0.1:8188->8188/tcp, 0.0.0.0:9000->9000/tcp` -- the host port is the
# first number after the address, and it is the one the console probes on.
_PUBLISHED = re.compile(r":(\d+)->")


async def port_cards(devices: list[dict]) -> dict[int, list[str]]:
    """{published host port: the PCI addresses that container holds}.

    The join the VRAM policy needs, and the only exact one available. A ComfyUI
    instance reports its device as a torch string -- `xpu:0 Intel(R) Arc(TM)
    Pro B70 Graphics` -- with no PCI address in it, so matching an instance to
    a card by name cannot tell two identical cards apart. The port it answers
    on, though, is published by exactly one container, and that container's
    device bindings say which card it was given.
    """
    survey_result = await survey(devices)
    mapping: dict[int, list[str]] = {}
    for container in survey_result["containers"]:
        addresses = [card["pci_bdf_address"] for card in container["cards"]]
        if not addresses:
            continue
        for port in _PUBLISHED.findall(container["ports"] or ""):
            mapping[int(port)] = addresses
    return mapping


async def image_sizes() -> dict[str, str]:
    """{image reference: human size} for what is on this disk."""
    listing = await _docker("images", "--format", "{{.Repository}}:{{.Tag}}\t{{.Size}}")
    found: dict[str, str] = {}
    for line in (listing or "").splitlines():
        name, _, size = line.partition("\t")
        if name:
            found[name.strip()] = size.strip()
    return found


async def by_card(devices: list[dict]) -> dict[str, list[dict]]:
    """{PCI address: the containers holding that card, with their state}.

    The other direction from `port_cards`, and what a per-card view needs: the
    question on that page is "what is this card doing", and the answer is the
    containers bound to it.
    """
    survey_result = await survey(devices)
    held: dict[str, list[dict]] = {}
    for container in survey_result["containers"]:
        for card in container["cards"]:
            held.setdefault(bus_key(card["pci_bdf_address"]), []).append({
                "name": container["name"],
                "state": container["state"],
                "image": container["image"],
                "ports": container["ports"],
            })
    return held


async def names() -> list[str]:
    """Just the container names, without the inspect pass the survey needs."""
    listing = await _docker("ps", "-a", "--format", "{{.Names}}")
    return listing.split() if listing else []


# The three verbs this module has, and the reason it has only these: each one
# acts on a container that already exists, with a configuration somebody with
# access to this machine already chose. `run` and `exec` would be
# indistinguishable from a root shell, because the console's own user is in the
# `docker` group.
VERBS = {"restart", "start", "stop"}


async def control(name: str, verb: str) -> bool:
    """Start, stop or restart one container that is on this machine.

    Both arguments are checked rather than trusted: the name arrives from a
    request, and `docker` would otherwise take whatever string it was handed.
    """
    if verb not in VERBS or name not in await names():
        return False
    return await _docker(verb, name) is not None
