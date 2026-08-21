"""How fast a model would generate on this machine, before it is downloaded.

Token generation is bandwidth-bound: every weight the model uses is read out of
VRAM once per token. So the time for one token is the bytes it has to read
divided by what the memory subsystem delivers, plus a fixed cost per block that
no amount of bandwidth removes.

    ms/token = (weight bytes + depth x KV bytes) / bandwidth + blocks x overhead

Both constants below were measured on this card rather than taken from a
datasheet -- which matters here more than usual, because the B70 will not report
its own memory bandwidth to anything (xpu-smi answers with the -1 sentinel and
Level Zero answers 64-bit at 2800 MHz, off by an order of magnitude).

The published calculators all stop at `size / bandwidth x 0.8`. Two details make
the difference between that and an answer worth showing:

  * **A mixture-of-experts model reads a fraction of itself.** The bytes come
    from the tensor directory, split into routed experts and everything else --
    not from the file size.
  * **The fixed cost is real and it dominates small models.** At 20 t/s on this
    card, 40.2 ms of each 50.0 ms token is streaming and 9.8 ms is roughly a
    thousand small kernel launches. A calculator without that term overstates a
    small model badly while looking right on a large one.
"""

from __future__ import annotations

# Measured 2026-08-15 on the Arc Pro B70, llama.cpp SYCL build.
#
# Not the STREAM figure (585 GB/s read, 96% of the card's 608 GB/s pin rate) but
# what the kernel that actually does the work reaches: `test-backend-ops perf -o
# MUL_MAT -p q6_K` gives 84.78 us for a 4096x14336 Q6_K mat-vec, which is 48.2 MB
# at 568 GB/s. The core kernel is already saturated; this is the honest ceiling.
BYTES_PER_SECOND = 568e9

# The rest of the 50.0 ms token, spread across ~1000 small kernel launches, and
# divided by the 65 blocks of the model it was measured on. Charged per block
# because that is what the launch count scales with.
OVERHEAD_PER_BLOCK = 9.8e-3 / 65

# What the KV cache costs per element. The models here run `--cache-type-k q8_0
# --cache-type-v q8_0`, which is 34 bytes per 32 elements.
KV_BYTES_PER_ELEMENT = 34 / 32

# The depth the estimate is quoted at. Generation slows as the cache fills --
# measured 33.2 t/s at 1K against 24.9 at 32K -- so a single number has to name
# the point it was taken at, and a few thousand tokens is where a conversation
# actually sits. Settable, because whose conversation is not this module's call.
DEPTH_DEFAULT = 4096

# One card, and the compute buffers have to live in it beside the weights.
VRAM_BYTES = 32 * 1024**3
COMPUTE_RESERVE = 1024**3


def _kv_bytes_per_token(head: dict) -> int:
    """Bytes added to the cache by one token.

    Every quantity here comes from the header, and two of them are the reason
    this cannot be guessed from the file listing: `attention_layers` (a hybrid
    model caches on a minority of its blocks -- 17 of 65 on Qwen3.8-27B) and
    `head_count_kv` (grouped-query attention shares one KV head across several
    query heads, which is most of the saving).
    """
    layers = head.get("attention_layers") or head.get("layers") or 0
    heads = head.get("head_count_kv") or head.get("head_count") or 0
    key = head.get("key_length") or 0
    value = head.get("value_length") or key
    if not (layers and heads and key):
        return 0
    return int(layers * heads * (key + value) * KV_BYTES_PER_ELEMENT)


def _weight_bytes(head: dict) -> int:
    """Bytes read from the weights for one token.

    For a dense model this is the whole file. For a mixture of experts it is
    everything outside the routed experts, plus the share of them the router
    actually reaches -- 8 of 128 on Qwen3-30B-A3B, which turns 17.3 GiB of file
    into 1.95 GiB of reading.
    """
    dense = head.get("dense_bytes") or 0
    routed = head.get("routed_bytes") or 0
    count = head.get("expert_count") or 0
    used = head.get("expert_used_count") or 0
    if routed and count and used:
        return int(dense + routed * used / count)
    return int(dense + routed)


def estimate(head: dict, file_bytes: int = 0) -> dict:
    """A generation-speed estimate for one GGUF, with what it rests on.

    The caveats travel with the number rather than being left to a footnote,
    because every one of them can move it by more than the number's own
    precision.
    """
    from . import settings
    depth = settings.get("estimate_depth")

    blocks = head.get("layers") or 0
    weights = _weight_bytes(head)
    kv_per_token = _kv_bytes_per_token(head)
    resident = file_bytes or (head.get("dense_bytes", 0) + head.get("routed_bytes", 0))

    seconds = (weights + depth * kv_per_token) / BYTES_PER_SECOND
    seconds += blocks * OVERHEAD_PER_BLOCK
    tok_s = 1 / seconds if seconds > 0 else 0.0

    # VRAM at a window worth having, not at the model's advertised maximum:
    # quoting 262144 would condemn models that run happily at 32K.
    window = min(int(head.get("context_length") or depth), 32768)
    needed = resident + window * kv_per_token + COMPUTE_RESERVE

    # A K-quant behaves like its byte count; an i-quant does not. Qwen3.8-27B
    # UD-Q4_K_XL -- Q5_K with IQ4_XS threaded through it -- measured 21.1 t/s
    # against the 24.0 this predicts, while the plain Q6_K of the same model
    # lands on its measured figure exactly. Two points cannot separate slower
    # dequantisation from a larger fixed cost, so the gap is reported rather
    # than silently corrected for.
    by_type = head.get("by_type") or {}
    total_typed = sum(by_type.values()) or 1
    iq_share = sum(size for name, size in by_type.items() if name.startswith("IQ")) / total_typed
    # The test is the i-quant share alone, not how mixed the file is: a plain
    # Q4_K_M is 77% Q4_K and 23% Q6_K by design, and it is not the slow case.
    mixed = iq_share > 0.1

    moe = bool(head.get("expert_count"))
    notes = []
    if mixed:
        notes.append(
            f"含 IQ 型別（約 {iq_share * 100:.0f}%），反量化成本比位元組數暗示的高："
            "本機唯一一次這種檔案的實測比估計低 14%。"
        )
    if moe:
        notes.append(
            f"MoE：{head['expert_count']} 位專家中每個 token 只讀 "
            f"{head['expert_used_count']} 位，所以實際讀取遠小於檔案大小。"
            "本機沒有實測過 MoE，專家收集的額外開銷未計入，實際會低於這個數字。"
        )
    if head.get("mtp"):
        notes.append(
            "含 MTP 推測解碼頭：開啟後實測可再快 15–65%（中文偏低、英文偏高），"
            "這個估計是關閉時的基準。"
        )
    if head.get("unknown_types"):
        notes.append("檔案含本程式不認識的量化型別，位元組數是估的。")
    if needed > VRAM_BYTES:
        notes.append("放不進 32 GiB 顯存，部分層會落到 CPU，實際速度會遠低於此。")

    return {
        "tok_s": round(tok_s, 1),
        "ms_per_token": round(seconds * 1000, 1),
        "read_gib_per_token": round(weights / 1024**3, 3),
        "kv_kib_per_token": round(kv_per_token / 1024, 1),
        "depth": depth,
        "vram_gib": round(needed / 1024**3, 1),
        "window": window,
        "fits": needed <= VRAM_BYTES,
        # What the number is worth. The dense path reproduces the one model
        # measured here to within 0.3%; everything else is the same physics
        # applied where nobody has checked it yet.
        "confidence": "rough" if (head.get("unknown_types") or mixed) else
                      ("extrapolated" if moe else "calibrated"),
        "notes": notes,
    }
