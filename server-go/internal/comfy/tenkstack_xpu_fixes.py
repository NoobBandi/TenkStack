"""Workarounds for Intel XPU kernel bugs, loaded by ComfyUI as a custom node.

scaled_dot_product_attention in fp16/bf16 with no mask and a short key
sequence (32 keys or fewer) returns NaN for random 8- or 16-row tiles of the
output on the Arc Pro B70 (torch 2.14.0+xpu). The inputs are finite and the
same call in fp32, or with any attn_mask, is correct. Cross-attention to a
handful of tokens hits it: Trellis2/Pixal3D attends to 5 global image tokens,
and one NaN tile there spreads through the whole latent within a step.

Passing an all-zero additive mask with a row per query selects a kernel
without the bug and does not change the result. A broadcast mask
(1, 1, 1, keys) still takes the broken path; it has to be (1, 1, queries,
keys), which is small because the key side is short.
"""

import torch
import torch.nn.functional as F

SHORT_KEYS = 64  # measured bad up to 32; margin costs nothing

_original = F.scaled_dot_product_attention


def _sdpa(query, key, value, attn_mask=None, dropout_p=0.0, is_causal=False, **kwargs):
    if (attn_mask is None and not is_causal
            and query.device.type == "xpu"
            and query.dtype in (torch.float16, torch.bfloat16)
            and key.shape[-2] <= SHORT_KEYS):
        attn_mask = query.new_zeros((1,) * (query.dim() - 2) + (query.shape[-2], key.shape[-2]))
    return _original(query, key, value, attn_mask=attn_mask, dropout_p=dropout_p, is_causal=is_causal, **kwargs)


if not getattr(F.scaled_dot_product_attention, "_tenkstack", False):
    _sdpa._tenkstack = True
    F.scaled_dot_product_attention = _sdpa
    torch.nn.functional.scaled_dot_product_attention = _sdpa

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
