"""Give each tensor-parallel worker only its own card: vLLM on two Intel cards.

Run by the launcher inside the container, before the server starts, when an
entry spans more than one card.

Why: with both cards visible to every worker, the compute-runtime in Intel's
image (26.09 and later; 26.14 in 0.26.0-b2) mirrors each worker's device
allocations as pinned host memory for the other card, because the cards
cannot reach each other directly on a desktop board
(https://github.com/intel/compute-runtime/issues/953). A 27B at FP8 across two
Arc Pro B70 held about 64 GB of host RAM that way; with this patch, 16 GB, at
the same tokens per second.

What it changes, in the installed vLLM:
  1. v1/executor/multiproc_executor.py: each worker is started with
     ZE_AFFINITY_MASK naming its own card, taken from ONEAPI_DEVICE_SELECTOR,
     so Level Zero never opens the other one.
  2. v1/worker/xpu_worker.py: such a worker uses device 0, the only one it
     sees, and is not held to seeing every card of the group (up to 0.30; 0.31
     dropped that check, so there the edit has nothing to do).
  3. v1/worker/mamba_utils.py: two device addresses stored in an int64 array
     are reinterpreted like the others there, since a worker's addresses can
     sit above 2**63.
The launcher also sets oneCCL's simple-algorithm thresholds so no collective
opens the other card's memory (https://github.com/intel/llm-scaler/issues/594).

Two workers only: that is what was measured. With more, the patch changes
nothing and says so. Written against intel/llm-scaler-vllm:0.26.0-b2 and
applies unchanged to vllm/vllm-openai-xpu:v0.30.0 (host RAM 11.8 GB for the
same FP8 27B), and to vllm/vllm-openai-xpu:v0.31.0 less the check it no
longer has. If an anchor is missing the script exits non-zero and the
container stops, since a half-applied patch hangs at start instead of
failing -- unless the edit is to a check upstream has since removed. Run as
a script, so it patches the installed vLLM even from the v0.30.0 image's
workdir, /workspace/vllm, which holds a source tree.

After the approach in github.com/SergiioB/intel-arc-pro-b70-inference-cookbook
(MIT).
"""
import importlib.metadata
import importlib.util
import sys
from pathlib import Path

# Found, not imported: importing vllm would load torch before the server does.
ROOT = Path(importlib.util.find_spec("vllm").origin).parent
VERSION = importlib.metadata.version("vllm")

EDITS = [
    (
        "v1/executor/multiproc_executor.py",
        "                global_rank = global_start_rank + local_rank\n",
        "                global_rank = global_start_rank + local_rank\n"
        "                # TENKSTACK_MULTI_CARD: this worker sees only its own card.\n"
        "                if os.environ.get(\"TENKSTACK_MULTI_CARD\") == \"1\" and self.local_world_size == 2:\n"
        "                    _tk_cards = os.environ.get(\"ONEAPI_DEVICE_SELECTOR\", \"\").split(\":\")[-1].split(\",\")\n"
        "                    if len(_tk_cards) != self.local_world_size:\n"
        "                        _tk_cards = [str(i) for i in range(self.local_world_size)]\n"
        "                    os.environ[\"ZE_AFFINITY_MASK\"] = _tk_cards[local_rank]\n"
        "                    os.environ[\"ONEAPI_DEVICE_SELECTOR\"] = \"level_zero:0\"\n"
        "                    print(f\"[tenkstack] worker {global_rank} on card {_tk_cards[local_rank]}\", flush=True)\n"
        "                elif os.environ.get(\"TENKSTACK_MULTI_CARD\") == \"1\" and local_rank == 0:\n"
        "                    print(f\"[tenkstack] {self.local_world_size} workers: one card per worker is only done \"\n"
        "                          \"for two, as measured; every worker sees every card\", flush=True)\n",
    ),
    (
        "v1/worker/xpu_worker.py",
        "    def init_device(self):\n"
        "        # In DP mode, XPU workers see all visible devices.\n",
        "    def init_device(self):\n"
        "        # TENKSTACK_MULTI_CARD: started seeing only its own card.\n"
        "        _tk_own_card = \"ZE_AFFINITY_MASK\" in os.environ and os.environ.get(\"TENKSTACK_MULTI_CARD\") == \"1\"\n"
        "        if _tk_own_card:\n"
        "            if torch.accelerator.device_count() != 1:\n"
        "                raise RuntimeError(\"tenkstack: a worker meant to see one card sees \"\n"
        "                                   f\"{torch.accelerator.device_count()}\")\n"
        "            self.local_rank = 0\n"
        "        # In DP mode, XPU workers see all visible devices.\n",
    ),
    (
        "v1/worker/xpu_worker.py",
        "            assert parallel_config.local_world_size <= visible_device_count, (\n",
        "            assert _tk_own_card or parallel_config.local_world_size <= visible_device_count, (\n",
        # Optional: 0.31 no longer asserts a worker sees the whole group.
        "parallel_config.local_world_size <= visible_device_count",
    ),
    (
        "v1/worker/mamba_utils.py",
        "                src_ptrs_np[offset] = copy_spec.start_addr\n"
        "                dst_ptrs_np[offset] = state[dest_block_id].data_ptr()\n",
        "                src_ptrs_np[offset] = _reinterpret_u64_as_i64(copy_spec.start_addr)  # TENKSTACK_MULTI_CARD\n"
        "                dst_ptrs_np[offset] = _reinterpret_u64_as_i64(state[dest_block_id].data_ptr())\n",
    ),
]


def main() -> int:
    texts: dict[str, str] = {}
    for rel, anchor, replacement, *gone in EDITS:
        text = texts.get(rel)
        if text is None:
            text = (ROOT / rel).read_text()
        if replacement in text:
            texts[rel] = text
            continue
        if gone and gone[0] not in text:
            # What the edit changes is no longer there at all: nothing to do.
            texts[rel] = text
            continue
        if text.count(anchor) != 1:
            print(f"[tenkstack] {rel}: the code this patch expects is not there "
                  f"(vLLM {VERSION}); not starting half-patched", file=sys.stderr)
            return 1
        texts[rel] = text.replace(anchor, replacement)
    for rel, text in texts.items():
        (ROOT / rel).write_text(text)
    print(f"[tenkstack] one card per worker (vLLM {VERSION})", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
