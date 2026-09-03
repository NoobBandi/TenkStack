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
from dataclasses import dataclass
from pathlib import Path

from . import channels, containers, paths, vendors

logger = logging.getLogger(__name__)

# One image per vendor, from the same publisher, so the entrypoint and the
# storage layout are identical across cards and this module needs one recipe
# rather than three.
def _images() -> dict[str, dict]:
    """ComfyUI's image per vendor, from the vendor records.

    One image per vendor from the same publisher, so the entrypoint and the
    storage layout are identical across cards and this module needs one recipe
    rather than three.
    """
    return {
        vendor.key: {"label": vendor.label, "image": vendor.comfy.image,
                     "verified": vendor.comfy.verified}
        for vendor in vendors.all_vendors() if vendor.comfy
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
    is a machine nobody can read. The naming is the vendor's, since only it
    knows what its cards are usually called.
    """
    key = card.get("vendor") or "gpu"
    same = [c for c in cards if (c.get("vendor") or "gpu") == key]
    index = same.index(card) if card in same else 0
    vendor = vendors.get(key)
    return vendor.slot(index) if vendor else f"{key}{index}"


def _device_flags(card: dict, cards: list[dict]) -> list[str]:
    """How this vendor's card is handed to a container.

    Asked of the vendor, because the mechanisms are genuinely different rather
    than differently spelled: Intel and AMD pass a render node through, NVIDIA
    goes through its container toolkit and names a CUDA ordinal, and a card
    whose runtime does neither supplies its own.
    """
    vendor = vendors.get(card.get("vendor") or "")
    return vendor.device_flags(card, cards) if vendor else []


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
    spec = _images().get(vendor)
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
        "-p", f"127.0.0.1:{target}:8188",
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


async def reconfigure(name: str, chosen: list[dict], cards: list[dict],
                      cli_args: str = "", port: int | None = None) -> None:
    """Rebuild one instance with a different set of cards.

    A container is bound to its cards at `docker run` and to nothing afterwards,
    so changing which cards it has means replacing the container. Everything
    else is kept: the same name, the same published port, the same directories,
    and the site block in front of it -- the instance the user opens is the same
    instance, with different hardware behind it.

    The volumes are not read back off the old container; they are derived from
    the slot exactly as `create` derives them. Reading them back would preserve
    a mistake as faithfully as a choice.

    Note what this does and does not buy. Two render nodes make two XPUs visible
    to torch, and ComfyUI still runs its graph on one of them: splitting a model
    across cards is the job of a MultiGPU-style custom node, which decides where
    each component goes. Passing both cards in is the prerequisite for that, not
    a substitute for it.
    """
    if not chosen:
        raise ValueError("至少要指定一張卡")

    detail = await containers._inspect([name])
    info = detail.get(name)
    if not info:
        raise ValueError(f"沒有這個容器：{name}")

    image = (info.get("Config") or {}).get("Image")
    if not image:
        raise ValueError(f"讀不到 {name} 的映像名稱")

    current = None
    bindings = (info.get("HostConfig") or {}).get("PortBindings") or {}
    for published in bindings.values():
        for entry in published or []:
            with contextlib.suppress(TypeError, ValueError):
                current = int(entry.get("HostPort"))
    if current is None:
        raise ValueError(f"讀不到 {name} 的連接埠")

    target = current if port is None else int(port)
    if target not in PORTS:
        # Outside this range the console would not find the instance again: the
        # probe walks these ports and nothing else knows where to look.
        raise ValueError(f"連接埠要在 {PORTS.start}-{PORTS.stop - 1} 之間")
    if target != current:
        taken = set()
        for entry in (await containers.survey(cards))["containers"]:
            if entry["name"] == name:
                continue
            for published in containers._PUBLISHED.findall(entry["ports"] or ""):
                taken.add(int(published))
        if target in taken:
            raise ValueError(f"連接埠 {target} 已經被別的容器用了")

    slot = name[len(PREFIX) + 1:] if name.startswith(f"{PREFIX}-") else name
    root = paths.COMFY_DIR
    shared = root / "storage-models"
    user = root / "storage-user"

    # The site block is keyed on the upstream port, so it only has to be
    # rewritten when that moves. Tearing it down for an unchanged port would
    # restart Caddy for nothing.
    await destroy(name, delete_image=False, unpublish=target != current)

    devices: list[str] = []
    for card in chosen:
        devices.extend(_device_flags(card, cards))

    args = [
        "run", "-d", "--name", name, "--restart", "unless-stopped",
        "-p", f"127.0.0.1:{port}:8188",
        *devices,
        "-e", f"CLI_ARGS={cli_args}",
        "-v", f"{shared / 'models'}:/root/ComfyUI/models",
        "-v", f"{shared / 'hf-hub'}:/root/.cache/huggingface/hub",
        "-v", f"{shared / 'torch-hub'}:/root/.cache/torch/hub",
        "-v", f"{user / 'input'}:/root/ComfyUI/input",
        "-v", f"{user / f'output-{slot}'}:/root/ComfyUI/output",
        "-v", f"{user / 'user-profile'}:/root/ComfyUI/user",
        "-v", f"{user / 'user-scripts'}:/root/user-scripts",
        "-v", f"{root / f'storage-{slot}'}:/root",
        image,
    ]
    if await containers._docker(*args) is None:
        raise ValueError(f"無法重建 {name}，詳細原因在主控台的日誌裡")
    if target != current:
        try:
            await channels.publish_comfyui(target, note=name)
        except Exception:
            logger.exception("rebuilt %s on :%d but could not publish it", name, target)
    logger.info("rebuilt %s on %d card(s), port %d, CLI_ARGS=%r",
                name, len(chosen), target, cli_args)


async def state(card: dict, cards: list[dict], boxes: list[dict]) -> dict:
    """What the image side of one card's row needs to say.

    `image` is the one actually behind the running instance when there is one,
    and the template's otherwise -- the same rule the model side follows, and
    for the same reason: what is installed beats what would be.
    """
    vendor = card.get("vendor") or ""
    spec = _images().get(vendor)
    box = boxes[0] if boxes else None
    image = (box or {}).get("image") or (spec or {}).get("image")
    sizes = await containers.image_sizes()
    return {
        "template": {**spec, "vendor": vendor} if spec else None,
        "container": (box or {}).get("name"),
        "image": image,
        "image_size": sizes.get(image or ""),
        "slot": _slot(card, cards),
        "job": job_for(card),
    }


async def destroy(name: str, delete_image: bool = False, unpublish: bool = True) -> None:
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
    if upstream is not None and unpublish:
        try:
            await channels.unpublish_comfyui(upstream)
        except Exception:
            logger.exception("removed %s but could not unpublish :%d", name, upstream)
    if image:
        if await containers._docker("rmi", image) is None:
            logger.warning("removed %s but could not delete %s", name, image)


@dataclass
class Job:
    """One long ComfyUI operation, as the page needs to see it.

    These take minutes -- the images are 16 to 20 GB -- so none of them may
    happen inside the request that asked for them. The request starts the work
    and returns; the row polls and draws a bar. A button that spins for two
    minutes is indistinguishable from one that has hung.
    """
    card: str
    action: str                 # create | update
    state: str = "pulling"      # pulling | starting | done | error
    layers_done: int = 0
    layers_total: int = 0
    message: str = ""

    def as_dict(self) -> dict:
        return {
            "card": self.card, "action": self.action, "state": self.state,
            "layers_done": self.layers_done, "layers_total": self.layers_total,
            "message": self.message,
        }


_jobs: dict[str, Job] = {}


def job_for(card: dict) -> dict | None:
    address = card.get("pci_bdf_address")
    key = containers.bus_key(address) if address else ""
    record = _jobs.get(key)
    return record.as_dict() if record else None


def _busy(key: str) -> Job | None:
    record = _jobs.get(key)
    return record if record and record.state in {"pulling", "starting"} else None


async def start(card: dict, cards: list[dict], action: str, name: str = "") -> dict:
    """Begin a create or an update in the background, and return immediately."""
    address = card.get("pci_bdf_address") or ""
    key = containers.bus_key(address)

    running = _busy(key)
    if running:
        return running.as_dict()

    vendor = card.get("vendor") or ""
    spec = _images().get(vendor)
    if spec is None:
        raise ValueError(f"沒有 {vendor} 的 ComfyUI 映像範本")

    if action == "create" and f"{PREFIX}-{_slot(card, cards)}" in await containers.names():
        raise ValueError("這張卡上已經有 ComfyUI 實例了")
    if action == "update" and not name:
        raise ValueError("要更新哪一個實例？")

    image = spec["image"]
    if action == "update":
        detail = await containers._inspect([name])
        image = ((detail.get(name) or {}).get("Config") or {}).get("Image") or image

    record = Job(card=key, action=action)
    _jobs[key] = record

    async def run() -> None:
        try:
            # Pulled explicitly rather than left to `docker run`, which would
            # do it silently and give this nothing to report.
            if not await containers.pull(image, record):
                return
            record.state = "starting"
            if action == "update":
                # The port does not change, so the site block does not either.
                # Rewriting it would work and would throw away whatever comment
                # somebody had put above it, which is the only thing in that
                # file this console did not write.
                await destroy(name, False, unpublish=False)
            await create(card, cards)
            record.state = "done"
        except Exception as exc:
            record.state, record.message = "error", str(exc)
            logger.exception("ComfyUI %s on %s failed", action, key)

    asyncio.create_task(run())
    return record.as_dict()
