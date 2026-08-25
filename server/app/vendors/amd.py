"""AMD, through rocm-smi and the ROCm runtime.

UNVERIFIED. No AMD card has been in the machine this was written on: the
recipes below are the documented ones and have never been run. That is worth
saying in the record rather than discovering after a seven gigabyte download,
which is what `verified` is for.
"""

from __future__ import annotations

from ..gpu.amd import Amd
from . import Image, Vendor
from ._shared import claims_by_render, render_path

# ROCm needs the compute node as well as the render node, and the group that
# owns them.
_EXTRA = ["--device", "/dev/kfd", "--group-add", "video",
          "--security-opt", "seccomp=unconfined"]

VENDOR = Vendor(
    key="amd",
    label="AMD (ROCm)",
    provider=Amd(),
    backends=("ROCM", "HIP"),
    selector=("HIP_VISIBLE_DEVICES", "{}"),
    llama=Image(image="ghcr.io/ggml-org/llama.cpp:server-rocm", verified=False),
    comfy=Image(image="yanwk/comfyui-boot:rocm", verified=False),
    device_flags=lambda card, cards: [
        "--device", render_path(card.get("pci_bdf_address") or ""), *_EXTRA,
    ],
    claims=claims_by_render,
    slot=lambda index: f"rocm{index}",
)
