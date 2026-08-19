"""Creating and removing the ComfyUI instance on a card.

The other half of what a card can do. A model runs through a launcher this
console can write; an image is drawn by a container this console can now
create, so the two switches on the runtime page mean the same kind of thing on
both sides -- and a fresh machine can start with neither.

The recipe is not invented. It is the arrangement already running here, read
back off the existing containers and parameterised: one instance per card,
because the card is fixed when the process starts, sharing the model directory
and the caches with every other instance while keeping its own output folder
and its own home. Sharing the models is the whole point -- a checkpoint is tens
of gigabytes and does not want a copy per card -- and separating the rest is
what keeps two instances from writing over each other's outputs.

Ports follow the same convention the console already probes on: 8188 upward on
loopback. What this does not do is publish a new instance through Caddy; that
is a site block per instance in a channel file, and adding one is a decision
about who can reach it rather than about what the card does.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from pathlib import Path

from . import channels, containers, paths

logger = logging.getLogger(__name__)

# One image per vendor, from the same publisher, so the entrypoint and the
# storage layout are identical across cards and this module needs one recipe
# rather than three.
IMAGES: dict[str, dict] = {
    "intel": {
        "label": "Intel (XPU)",
        "image": "yanwk/comfyui-boot:xpu",
        "verified": True,
    },
    "nvidia": {
        "label": "NVIDIA (CUDA)",
        "image": "yanwk/comfyui-boot:cu130-slim-v2",
        "verified": True,
    },
    "amd": {
        "label": "AMD (ROCm)",
        "image": "yanwk/comfyui-boot:rocm",
        # No AMD card has been in this machine. Written from the same recipe
        # the other two use, never run.
        "verified": False,
    },
}

# Where the console probes for instances, and therefore where a new one has to
# land to be seen at all.
PORTS = range(8188, 8192)

# The prefix every instance's name carries, so the log reader and the container
# survey find it without being told.
PREFIX = "comfyui"


def _slot(card: dict, cards: list[dict]) -> str:
    """A short name for the instance on this card.

    Follows what is already here -- `comfyui-xpu`, `comfyui-nv0` -- because the
    names appear in logs, in the container list and in the output directory,
    and a machine whose first instance is called one thing and second another
    is a machine nobody can read.
    """
    vendor = card.get("vendor") or "gpu"
    same = [c for c in cards if (c.get("vendor") or "gpu") == vendor]
    index = same.index(card) if card in same else 0
    if vendor == "intel":
        return "xpu" if index == 0 else f"xpu{index}"
    if vendor == "nvidia":
        return f"nv{index}"
    return f"{vendor}{index}"


def _device_flags(card: dict, cards: list[dict]) -> list[str]:
    """How this vendor's card is handed to a container.

    Three different mechanisms, which is why this is a function and not a
    string in the table above. Intel and AMD pass a render node through; NVIDIA
    goes through its container toolkit and names a CUDA ordinal, which counts
    NVIDIA cards alone and is not the console's own index.
    """
    vendor = card.get("vendor") or ""
    address = card.get("pci_bdf_address") or ""
    if vendor == "nvidia":
        nvidia = [c for c in cards if c.get("vendor") == "nvidia"]
        ordinal = nvidia.index(card) if card in nvidia else 0
        return ["--gpus", f"device={ordinal}"]

    # By path rather than by number: render node numbering is probe order, so a
    # card added later can move renderD128 to another device. Falls back to the
    # whole of /dev/dri when the machine has no by-path links, which gives the
    # container every render node rather than the wrong one.
    node = Path(f"/dev/dri/by-path/pci-{address.lower()}-render")
    flags = ["--device", str(node) if node.exists() else "/dev/dri"]
    if vendor == "amd":
        flags += ["--device", "/dev/kfd", "--group-add", "video",
                  "--security-opt", "seccomp=unconfined"]
    return flags


async def _free_port(taken: set[int]) -> int | None:
    for port in PORTS:
        if port not in taken:
            return port
    return None


async def create(card: dict, cards: list[dict]) -> str:
    """Start a ComfyUI instance bound to one card.

    Returns the container name. Everything about it is derived: the vendor
    decides the image and how the card is passed through, the slot decides the
    name and the private directories, and the port is the first free one in the
    range the console already looks at.
    """
    vendor = card.get("vendor") or ""
    spec = IMAGES.get(vendor)
    if spec is None:
        raise ValueError(f"沒有 {vendor} 的 ComfyUI 映像範本")

    slot = _slot(card, cards)
    name = f"{PREFIX}-{slot}"
    if name in await containers.names():
        raise ValueError(f"{name} 已經存在")

    used = set()
    for entry in (await containers.survey(cards))["containers"]:
        for port in containers._PUBLISHED.findall(entry["ports"] or ""):
            used.add(int(port))
    port = await _free_port(used)
    if port is None:
        raise ValueError(f"連接埠 {PORTS.start}-{PORTS.stop - 1} 都被佔用了")

    root = paths.COMFY_DIR
    shared = root / "storage-models"
    user = root / "storage-user"
    # Created rather than required: this is the install, and refusing to make
    # the directory it is about to mount would leave nothing for the user to do
    # but make it by hand with the same name.
    for directory in (shared / "models", shared / "hf-hub", shared / "torch-hub",
                      user / "input", user / "user-profile", user / "user-scripts",
                      user / f"output-{slot}", root / f"storage-{slot}"):
        directory.mkdir(parents=True, exist_ok=True)

    args = [
        "run", "-d", "--name", name, "--restart", "unless-stopped",
        "-p", f"127.0.0.1:{port}:8188",
        *_device_flags(card, cards),
        "-v", f"{shared / 'models'}:/root/ComfyUI/models",
        "-v", f"{shared / 'hf-hub'}:/root/.cache/huggingface/hub",
        "-v", f"{shared / 'torch-hub'}:/root/.cache/torch/hub",
        "-v", f"{user / 'input'}:/root/ComfyUI/input",
        "-v", f"{user / f'output-{slot}'}:/root/ComfyUI/output",
        "-v", f"{user / 'user-profile'}:/root/ComfyUI/user",
        "-v", f"{user / 'user-scripts'}:/root/user-scripts",
        "-v", f"{root / f'storage-{slot}'}:/root",
        spec["image"],
    ]
    if await containers._docker(*args) is None:
        raise ValueError(f"無法建立 {name}，詳細原因在主控台的日誌裡")
    logger.info("created ComfyUI instance %s on %s port %d", name, vendor, port)

    # Published as well as created, or a new card gets an instance nobody in
    # the house can open. Not fatal if it fails: the instance is real and
    # working on loopback, the console can already see it, and the reason to
    # separate the two is that reaching it from another machine is a question
    # about the network rather than about the card.
    try:
        await channels.publish_comfyui(port, note=f"{spec['label']} -- {card.get('name') or slot}")
    except Exception:
        logger.exception("created %s but could not publish it through Caddy", name)
    return name


async def state(card: dict, cards: list[dict], boxes: list[dict]) -> dict:
    """What the image side of one card's row needs to say.

    `image` is the one actually behind the running instance when there is one,
    and the template's otherwise -- the same rule the model side follows, and
    for the same reason: what is installed beats what would be.
    """
    vendor = card.get("vendor") or ""
    spec = IMAGES.get(vendor)
    box = boxes[0] if boxes else None
    image = (box or {}).get("image") or (spec or {}).get("image")
    sizes = await containers.image_sizes()
    return {
        "template": {**spec, "vendor": vendor} if spec else None,
        "container": (box or {}).get("name"),
        "image": image,
        "image_size": sizes.get(image or ""),
        "slot": _slot(card, cards),
    }


async def destroy(name: str, delete_image: bool = False) -> None:
    """Stop and remove one instance, and optionally its image.

    The instance's own directories are left alone. They hold outputs and a
    settings profile that took someone time to arrive at, and deleting a
    container is not a statement about either.
    """
    if name not in await containers.names():
        raise ValueError(f"沒有這個容器：{name}")

    detail = await containers._inspect([name])
    config = (detail.get(name) or {}).get("Config") or {}
    image = config.get("Image") if delete_image else None

    # Read before the container goes: the published port is the only link back
    # to the site block that has to go with it.
    upstream = None
    bindings = ((detail.get(name) or {}).get("HostConfig") or {}).get("PortBindings") or {}
    for published in bindings.values():
        for entry in published or []:
            with contextlib.suppress(TypeError, ValueError):
                upstream = int(entry.get("HostPort"))

    await containers._docker("rm", "-f", name)
    if upstream is not None:
        try:
            await channels.unpublish_comfyui(upstream)
        except Exception:
            logger.exception("removed %s but could not unpublish :%d", name, upstream)
    if image:
        if await containers._docker("rmi", image) is None:
            logger.warning("removed %s but could not delete %s", name, image)
