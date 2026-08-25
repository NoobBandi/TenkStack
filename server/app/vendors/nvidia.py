"""NVIDIA, through nvidia-smi and the container toolkit.

The one vendor here that does not pass a device node through. Its cards reach
a container as a *device request* handled by nvidia-container-toolkit, which
also means the toolkit has to be installed on the host -- the kernel driver
alone is not enough, and a machine with the driver but not the toolkit fails
at `docker run` with an error that does not say so.
"""

from __future__ import annotations

from ..gpu.nvidia import Nvidia
from . import Image, Vendor


def _ordinal(card: dict, cards: list[dict]) -> int:
    """This card's position among the NVIDIA cards.

    Not the console's own index, which counts every card in the machine. A
    CUDA ordinal counts NVIDIA cards alone, so the `0` in a device request is
    not the `0` of the console's first device.
    """
    mine = [c for c in cards if c.get("vendor") == "nvidia"]
    return mine.index(card) if card in mine else 0


def _claims(host: dict, cards: list[dict]) -> tuple[list[str], bool]:
    """Which cards a container got, read back out of its device requests."""
    mine = [c for c in cards if c.get("vendor") == "nvidia"]
    claimed: list[str] = []
    wants = False

    for request in host.get("DeviceRequests") or []:
        if not any("gpu" in group for group in (request.get("Capabilities") or [])):
            continue
        wants = True
        ordinals = request.get("DeviceIDs") or []
        if not ordinals or "all" in ordinals:
            claimed += [c["pci_bdf_address"] for c in mine if c.get("pci_bdf_address")]
            continue
        for wanted in ordinals:
            text = str(wanted)
            if text.isdigit():
                if int(text) < len(mine) and mine[int(text)].get("pci_bdf_address"):
                    claimed.append(mine[int(text)]["pci_bdf_address"])
                continue
            # Otherwise a UUID, which is how a request pins a card that may
            # move ordinal.
            for card in mine:
                if text in str((card.get("raw") or {}).get("uuid") or ""):
                    if card.get("pci_bdf_address"):
                        claimed.append(card["pci_bdf_address"])
    return claimed, wants


VENDOR = Vendor(
    key="nvidia",
    label="NVIDIA (CUDA)",
    provider=Nvidia(),
    backends=("CUDA",),
    selector=("CUDA_VISIBLE_DEVICES", "{}"),
    llama=Image(
        image="ghcr.io/ggml-org/llama.cpp:server-cuda",
        requires="nvidia-container-toolkit",
        verified=True,
    ),
    comfy=Image(
        image="yanwk/comfyui-boot:cu130-slim-v2",
        requires="nvidia-container-toolkit",
        verified=True,
    ),
    device_flags=lambda card, cards: ["--gpus", f"device={_ordinal(card, cards)}"],
    claims=_claims,
    slot=lambda index: f"nv{index}",
)
