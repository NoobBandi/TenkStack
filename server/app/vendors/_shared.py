"""Mechanisms more than one vendor uses.

The DRM render node is the common case -- everything that is not NVIDIA hands
a card to a container this way -- so it lives here rather than being copied
into each module that wants it.
"""

from __future__ import annotations

from pathlib import Path

DRM_CLASS = Path("/sys/class/drm")


def render_path(address: str) -> str:
    """The device path for one card's render node, resolved to its number.

    Found by path, handed over by number, and both halves are necessary.

    Found by path because `renderD128` is assigned in probe order, so a card
    added later can quietly move it to another device and looking the node up by
    number would risk a container talking to the wrong card.

    Handed over by number because docker cannot take the by-path name. `--device`
    is parsed as `host:container:permissions`, and the link contains the PCI
    address -- `pci-0000:10:00.0-render` -- so docker reads `00.0-render` as the
    permission bits and refuses the flag outright. Nothing with a colon in its
    name can be passed through. Resolving here is also when docker would have
    resolved it, so nothing is lost by doing it a moment earlier.

    Falls back to the whole of `/dev/dri` where the machine has no by-path
    links, which gives the container every node rather than the wrong one.
    """
    node = Path(f"/dev/dri/by-path/pci-{address.lower()}-render")
    return str(node.resolve()) if node.exists() else "/dev/dri"


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
