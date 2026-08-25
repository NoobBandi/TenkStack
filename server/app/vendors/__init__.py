"""One file per vendor, and everything about that vendor in it.

A card used to arrive in this console as edits to six places in four files: the
telemetry provider list, the llama.cpp image table, the environment variable
that pins a device, the backend name `--list-devices` prints, the ComfyUI
image, and two `if vendor == …` branches deciding how the card is handed to a
container. Every one of them was small; together they were the reason adding a
card meant reading the whole codebase first.

They are one record now. A vendor is described once, in its own module, and
registered by being importable -- so supporting a card nobody here has is
writing `vendors/<name>.py`, not finding six tables.

WHAT A VENDOR HAS TO ANSWER

The four telemetry questions are `gpu.base.Provider` and unchanged. What this
adds is the rest of what the console does with a card, and the two parts that
genuinely differ between vendors rather than merely differing in a string:

  * **How a card is given to a container.** Intel and AMD pass a render node
    through as a device; NVIDIA goes through its container toolkit and names a
    CUDA ordinal. A vendor whose runtime does neither -- Ascend's `/dev/davinci*`,
    Moore Threads' own container runtime -- supplies its own, which is why this
    is a function and not a list of flags.
  * **How to read that back.** Given a container's configuration, which cards
    did it get? The console needs this to say what each card is doing, and it
    is the inverse of the above rather than the same data.

Neither is optional and neither can be defaulted, which is why they are on the
record rather than in a table somewhere with a fallback.
"""

from __future__ import annotations

import importlib
import logging
import pkgutil
from dataclasses import dataclass, field
from typing import Callable, Protocol

logger = logging.getLogger(__name__)


class Provider(Protocol):
    """`gpu.base.Provider`, restated to keep this module import-light."""

    key: str
    label: str


@dataclass(frozen=True)
class Image:
    """A container image and what running it needs of the host."""

    image: str
    #: Something the host must already have for this image to work, named so
    #: the UI can say it before a multi-gigabyte download rather than after.
    requires: str | None = None
    #: False for a recipe written from documentation and never run here. Worth
    #: stating: an unverified recipe that fails costs somebody an evening.
    verified: bool = False
    #: Extra `docker run` arguments the image itself needs, beyond the card.
    flags: tuple[str, ...] = ()


@dataclass(frozen=True)
class Vendor:
    """Everything the console needs to know about one kind of card."""

    #: Matches `GpuSample.vendor`, and is the key everything else joins on.
    key: str
    label: str
    provider: Provider

    #: What llama.cpp calls this backend in `--list-devices` output, upper
    #: case: `("CUDA",)`, `("SYCL",)`. Used to route a chosen device back to
    #: the environment variable that pins it.
    backends: tuple[str, ...]
    #: (variable, value template). The value is the backend's own index, which
    #: counts this vendor's cards alone -- not the console's global index.
    selector: tuple[str, str]

    #: llama.cpp's server image for this backend, and ComfyUI's.
    llama: Image | None = None
    comfy: Image | None = None

    #: `docker run` arguments that hand one specific card to a container.
    #: (card, all_cards) -> flags
    device_flags: Callable[[dict, list[dict]], list[str]] = field(
        default=lambda card, cards: []
    )
    #: The inverse: given a container's HostConfig and the machine's cards,
    #: which cards did it get? Returns (PCI addresses, asked_for_a_gpu).
    claims: Callable[[dict, list[dict]], tuple[list[str], bool]] = field(
        default=lambda host, cards: ([], False)
    )

    #: Short name for an instance on this card -- `xpu`, `nv0` -- which appears
    #: in container names and output directories. (index within this vendor)
    slot: Callable[[int], str] = field(default=lambda index: f"gpu{index}")


_registry: dict[str, Vendor] = {}


def _discover() -> dict[str, Vendor]:
    """Every module in this package that exports a `VENDOR`.

    Importable rather than listed: a file dropped in here participates, and a
    file removed stops participating, with nothing to keep in step. A module
    that fails to import is logged and skipped -- one vendor's broken
    dependency must not take the console down on a machine that does not have
    that card.
    """
    if _registry:
        return _registry

    for info in pkgutil.iter_modules(__path__):
        if info.name.startswith("_"):
            continue
        try:
            module = importlib.import_module(f"{__name__}.{info.name}")
        except Exception:
            logger.exception("could not load the %s vendor module", info.name)
            continue
        vendor = getattr(module, "VENDOR", None)
        if isinstance(vendor, Vendor):
            _registry[vendor.key] = vendor
        else:
            logger.warning("%s has no VENDOR record; skipped", info.name)

    logger.info("vendors registered: %s", ", ".join(sorted(_registry)) or "none")
    return _registry


def all_vendors() -> list[Vendor]:
    """Every registered vendor, in a stable order.

    Intel first, deliberately, and then alphabetically. The order decides the
    console's global device numbering, and device 0 is the card llama-server
    runs on by default -- so it has to be stable across restarts rather than
    whatever the filesystem returned.
    """
    found = _discover()
    first = [found[key] for key in ("intel",) if key in found]
    rest = [found[key] for key in sorted(found) if key != "intel"]
    return first + rest


def get(key: str) -> Vendor | None:
    return _discover().get(key)


def backend_selectors() -> dict[str, tuple[str, str]]:
    """Backend name (as `--list-devices` prints it) -> how to pin one device."""
    out = {
        # Not a vendor: Vulkan runs on any of them, which is what makes it the
        # fallback rather than a row in the table.
        "VULKAN": ("GGML_VK_VISIBLE_DEVICES", "{}"),
    }
    for vendor in all_vendors():
        for backend in vendor.backends:
            out[backend.upper()] = vendor.selector
    return out


def selector_variables() -> set[str]:
    """The environment variables a device choice is written as."""
    return {variable for variable, _ in backend_selectors().values()}
