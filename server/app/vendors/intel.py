"""Intel Arc, through xpu-smi and the Level Zero runtime."""

from __future__ import annotations

from ..gpu.intel import Intel
from . import Image, Vendor
from ._shared import claims_by_render, render_path

VENDOR = Vendor(
    key="intel",
    label="Intel (SYCL)",
    provider=Intel(),
    backends=("SYCL",),
    # `level_zero:N` rather than a bare index: without the backend prefix SYCL
    # can select the CPU OpenCL device and run everything on the CPU while
    # reporting success.
    selector=("ONEAPI_DEVICE_SELECTOR", "level_zero:{}"),
    llama=Image(
        image="ghcr.io/ggml-org/llama.cpp:server-intel",
        verified=False,
    ),
    comfy=Image(
        image="yanwk/comfyui-boot:xpu",
        verified=True,
    ),
    device_flags=lambda card, cards: [
        "--device", render_path(card.get("pci_bdf_address") or ""),
    ],
    claims=claims_by_render,
    slot=lambda index: "xpu" if index == 0 else f"xpu{index}",
)
