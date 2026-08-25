"""Mechanisms more than one vendor uses.

The DRM render node is the common case -- everything that is not NVIDIA hands
a card to a container this way -- so it lives here rather than being copied
into each module that wants it.
"""

from __future__ import annotations

from pathlib import Path

DRM_CLASS = Path("/sys/class/drm")


def render_path(address: str) -> str:
    """The stable device path for one card's render node.

    By path rather than by number: `renderD128` is assigned in probe order, so
    a card added later can quietly move it to another device -- and a container
    created with the number then talks to the wrong card. Falls back to the
    whole of `/dev/dri` where the machine has no by-path links, which gives the
    container every node rather than the wrong one.
    """
    node = Path(f"/dev/dri/by-path/pci-{address.lower()}-render")
    return str(node) if node.exists() else "/dev/dri"


def pci_for_render(node: str) -> str | None:
    """The card behind `/dev/dri/renderD128`, as a PCI address."""
    try:
        return (DRM_CLASS / node / "device").resolve().name
    except OSError:
        return None


def claims_by_render(host: dict, cards: list[dict]) -> tuple[list[str], bool]:
    """Which cards a container got, for vendors that pass a render node."""
    claimed: list[str] = []
    wants = False
    for entry in host.get("Devices") or []:
        path = str(entry.get("PathOnHost") or "")
        if not path.startswith("/dev/dri/render"):
            continue
        wants = True
        address = pci_for_render(Path(path).name)
        if address:
            claimed.append(address)
    return claimed, wants
