"""Hugging Face search and GGUF downloads.

llama-swap does not download anything, so this is the piece the console has to
own outright. Downloads run as background tasks with progress kept in memory --
they do not survive a backend restart, but a half-written file is resumable, so
the cost of that is one re-request rather than lost bytes.

## Why the download is segmented

Measured on this machine, 2026-08-08: HF serves this repo from Xet storage, and
`us.aws.cdn.hf.co` resolves only to ap-southeast-1 hosts -- 60 ms away, with
heavy packet reordering (377k out-of-order packets on one transfer). A single
TCP stream could not exceed ~8 MiB/s on that path, while seven streams to the
*same* endpoint reached 41 MiB/s in aggregate.

So the limit is the bandwidth-delay product of one connection, not the server,
the account, or the link (which measures ~300 Mbps). Segmenting is the fix; no
amount of authentication changes it.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

HF_API = "https://huggingface.co/api"
MODELS_DIR = Path("/home/tenk/ai/models")

# Streamed block size within one segment. Only affects how often progress and
# the write syscall happen, not concurrency.
CHUNK = 1 << 20

# One unit of resumable work. Small enough that an interrupted download loses
# little, large enough that per-request overhead stays negligible on a 24 GiB
# file (~768 segments).
SEGMENT_SIZE = 32 << 20

# Connections per download. Past roughly this many the gain flattens while the
# odds of the CDN throttling a single client rise.
PARALLEL = 8


@dataclass
class Download:
    repo_id: str
    filename: str
    total_bytes: int = 0
    downloaded_bytes: int = 0
    state: str = "queued"  # queued | downloading | done | error | cancelled
    error: str | None = None
    started_at: float = field(default_factory=time.time)
    # Bytes already on disk when this run began. Excluded from the rate, or a
    # resumed download reports a wildly inflated speed for its first minute.
    resumed_bytes: int = 0
    _task: asyncio.Task | None = field(default=None, repr=False, compare=False)

    def as_dict(self) -> dict:
        elapsed = max(time.time() - self.started_at, 0.001)
        fresh = max(self.downloaded_bytes - self.resumed_bytes, 0)
        percent = (
            round(self.downloaded_bytes / self.total_bytes * 100, 1)
            if self.total_bytes else 0.0
        )
        return {
            "repo_id": self.repo_id,
            "filename": self.filename,
            "total_bytes": self.total_bytes,
            "downloaded_bytes": self.downloaded_bytes,
            "percent": percent,
            "state": self.state,
            "error": self.error,
            "mib_per_second": round(fresh / elapsed / 1024 / 1024, 1),
        }


_downloads: dict[str, Download] = {}


def _key(repo_id: str, filename: str) -> str:
    return f"{repo_id}/{filename}"


async def search(query: str, limit: int = 20) -> list[dict]:
    """Search for GGUF repos.

    Filtered to the gguf library because nothing else is runnable here: the
    backend is llama.cpp, and offering safetensors repos would produce entries
    that cannot be deployed.
    """
    params = {
        "search": query,
        "filter": "gguf",
        "limit": limit,
        "sort": "downloads",
        "direction": -1,
    }
    async with httpx.AsyncClient(timeout=15) as client:
        try:
            resp = await client.get(f"{HF_API}/models", params=params)
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            logger.warning("HF search failed: %s", exc)
            return []

    return [
        {
            "repo_id": m.get("id"),
            "downloads": m.get("downloads", 0),
            "likes": m.get("likes", 0),
            "last_modified": m.get("lastModified"),
            "tags": [t for t in (m.get("tags") or []) if not t.startswith(("base_model", "region"))][:8],
        }
        for m in resp.json()
    ]


async def list_files(repo_id: str) -> list[dict]:
    """GGUF files in a repo, with sizes, so the UI can warn before a 40 GiB pull."""
    async with httpx.AsyncClient(timeout=20) as client:
        try:
            resp = await client.get(f"{HF_API}/models/{repo_id}", params={"blobs": "true"})
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            logger.warning("HF file listing for %s failed: %s", repo_id, exc)
            return []

    data = resp.json()
    files = []
    for sibling in data.get("siblings") or []:
        name = sibling.get("rfilename", "")
        if not name.lower().endswith(".gguf"):
            continue
        size = sibling.get("size") or 0
        files.append({
            "filename": name,
            "size_bytes": size,
            "size_gib": round(size / 1024**3, 2),
            "is_mmproj": name.lower().startswith("mmproj"),
            "on_disk": (MODELS_DIR / Path(name).name).exists(),
        })
    return sorted(files, key=lambda f: f["size_bytes"])


async def _total_size(client: httpx.AsyncClient, url: str) -> int:
    """Ask for one byte and read the total out of Content-Range.

    A HEAD would be tidier, but HF's signed CDN URLs do not reliably answer it,
    and a one-byte ranged GET also proves the server supports ranges at all --
    which everything below depends on.
    """
    resp = await client.get(url, headers={"Range": "bytes=0-0"})
    resp.raise_for_status()
    content_range = resp.headers.get("content-range", "")
    if "/" in content_range:
        return int(content_range.rsplit("/", 1)[1])
    # No range support: fall back to the plain length and let the caller run a
    # single segment.
    return int(resp.headers.get("content-length", 0))


def _load_done(state_path: Path, segment_count: int) -> set[int]:
    try:
        data = json.loads(state_path.read_text())
        return {i for i in data.get("done", []) if 0 <= i < segment_count}
    except Exception:
        return set()


def _save_done(state_path: Path, done: set[int]) -> None:
    tmp = state_path.with_suffix(state_path.suffix + ".tmp")
    tmp.write_text(json.dumps({"done": sorted(done)}))
    tmp.replace(state_path)


def _materialised(path: Path) -> int:
    """Bytes actually written, not the size the file claims.

    The download preallocates with ftruncate, so `st_size` is the final size
    from the first moment and says nothing about progress. Only the allocated
    blocks distinguish a finished file from a sparse one full of holes.
    """
    try:
        stat = path.stat()
    except OSError:
        return 0
    return stat.st_blocks * 512


async def _fetch_segment(
    client: httpx.AsyncClient, url: str, fd: int, index: int, total: int, entry: Download,
) -> None:
    """Fetch one segment, leaving the progress counter untouched if it fails.

    The rollback has to be exactly what this attempt contributed -- a retry
    re-downloads the whole segment, so counting a partial attempt would inflate
    progress a little more on every failure.
    """
    start = index * SEGMENT_SIZE
    end = min(start + SEGMENT_SIZE, total) - 1
    offset = start
    contributed = 0

    try:
        async with client.stream("GET", url, headers={"Range": f"bytes={start}-{end}"}) as resp:
            if resp.status_code not in (200, 206):
                raise httpx.HTTPStatusError(
                    f"HTTP {resp.status_code}", request=resp.request, response=resp
                )
            async for block in resp.aiter_bytes(CHUNK):
                # pwrite, not seek+write: several coroutines share this
                # descriptor and a shared file offset would let them overwrite
                # each other.
                os.pwrite(fd, block, offset)
                offset += len(block)
                contributed += len(block)
                entry.downloaded_bytes += len(block)
    except BaseException:
        entry.downloaded_bytes -= contributed
        raise


async def _download(entry: Download) -> None:
    url = f"https://huggingface.co/{entry.repo_id}/resolve/main/{entry.filename}"
    target = MODELS_DIR / Path(entry.filename).name
    partial = target.with_suffix(target.suffix + ".part")
    state_path = partial.with_suffix(partial.suffix + ".state")

    entry.state = "downloading"
    entry.started_at = time.time()

    try:
        limits = httpx.Limits(max_connections=PARALLEL + 2, max_keepalive_connections=PARALLEL)
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=120.0),
                                     follow_redirects=True, limits=limits) as client:
            total = await _total_size(client, url)
            if total <= 0:
                raise RuntimeError("could not determine the remote file size")
            entry.total_bytes = total

            segment_count = (total + SEGMENT_SIZE - 1) // SEGMENT_SIZE
            # Only the state file is trusted. Guessing from the file's length
            # used to seed this set, but preallocation makes an interrupted
            # download indistinguishable from a finished one by length alone --
            # so every resume claimed every segment, wrote nothing, and renamed
            # a file full of holes into place.
            done = _load_done(state_path, segment_count)
            if done:
                logger.info("resuming %s with %d/%d segments already present",
                            entry.filename, len(done), segment_count)
            entry.downloaded_bytes = sum(
                min((i + 1) * SEGMENT_SIZE, total) - i * SEGMENT_SIZE for i in done
            )
            entry.resumed_bytes = entry.downloaded_bytes

            # Preallocate so segments can be written at their true offsets. This
            # is sparse until written, so it costs no disk up front.
            fd = os.open(partial, os.O_RDWR | os.O_CREAT)
            try:
                os.ftruncate(fd, total)

                pending: asyncio.Queue[int] = asyncio.Queue()
                for index in range(segment_count):
                    if index not in done:
                        pending.put_nowait(index)

                lock = asyncio.Lock()

                async def worker() -> None:
                    while True:
                        try:
                            index = pending.get_nowait()
                        except asyncio.QueueEmpty:
                            return
                        for attempt in range(3):
                            try:
                                await _fetch_segment(client, url, fd, index, total, entry)
                                break
                            except asyncio.CancelledError:
                                raise
                            except Exception as exc:
                                if attempt == 2:
                                    raise
                                logger.warning("segment %d of %s failed (%s); retrying",
                                               index, entry.filename, exc)
                                await asyncio.sleep(1 + attempt)
                        async with lock:
                            done.add(index)
                            _save_done(state_path, done)

                await asyncio.gather(*(worker() for _ in range(min(PARALLEL, segment_count))))
            finally:
                os.close(fd)

        # Two independent checks, because each catches what the other cannot:
        # the segment ledger proves every range was fetched, and the allocated
        # size proves those writes reached the disk. Comparing st_size to the
        # total proved nothing at all -- ftruncate had already set it.
        missing = segment_count - len(done)
        if missing:
            raise RuntimeError(f"{missing}/{segment_count} 個段落未完成")
        actual = _materialised(partial)
        if actual < total * 0.99:
            raise RuntimeError(
                f"檔案不完整：實際寫入 {actual / 1024**3:.2f} GiB，應為 {total / 1024**3:.2f} GiB"
            )

        partial.replace(target)
        state_path.unlink(missing_ok=True)
        entry.downloaded_bytes = total
        entry.state = "done"
        logger.info("downloaded %s (%.1f GiB)", target.name, total / 1024**3)
    except asyncio.CancelledError:
        entry.state = "cancelled"
        # .part and .part.state are kept on purpose so a retry resumes.
        raise
    except Exception as exc:
        entry.state = "error"
        entry.error = str(exc)
        logger.warning("download of %s failed: %s", entry.filename, exc)


def start(repo_id: str, filename: str) -> dict:
    key = _key(repo_id, filename)
    existing = _downloads.get(key)
    if existing and existing.state in ("queued", "downloading"):
        return existing.as_dict()

    entry = Download(repo_id=repo_id, filename=filename)
    _downloads[key] = entry
    entry._task = asyncio.create_task(_download(entry))
    return entry.as_dict()


def cancel(repo_id: str, filename: str) -> bool:
    entry = _downloads.get(_key(repo_id, filename))
    if entry and entry._task and not entry._task.done():
        entry._task.cancel()
        return True
    return False


def status() -> list[dict]:
    return [d.as_dict() for d in _downloads.values()]


def active_count() -> int:
    # queued counts too: a job accepted but not yet started is still something
    # the UI is waiting on, and skipping it would leave the list unpushed until
    # the first byte arrives.
    return sum(1 for d in _downloads.values() if d.state in ("queued", "downloading"))
