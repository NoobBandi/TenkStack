"""Web search, and reading a page.

WHY THIS IS ON THE SERVER

The sandbox cannot do it. Its frame has no origin, so every request it makes
carries `Origin: null` and only reaches hosts that explicitly allow that --
measured here, github.com and huggingface.co do, duckduckgo and every search
engine do not. That is CORS working as intended: a page cannot read another
site on the reader's behalf. So searching happens in this process, which is
not a browser and is not subject to it.

The alternative -- a fetch proxy the sandbox could call -- was rejected. To be
reachable from an opaque origin it would need `Access-Control-Allow-Origin: *`,
and an open proxy on a home network is an open proxy however it was meant.

WHY SEARXNG

No account, no key, no quota, and nothing outside this machine keeping a record
of what was asked. It queries the engines itself and merges what they return,
which is also why a result carries the engines that found it: two independent
engines agreeing is worth more than one, and the model can see that.
"""

from __future__ import annotations

import logging
import math
import os
import re
from collections import Counter
from html.parser import HTMLParser

import httpx

logger = logging.getLogger(__name__)

BASE = os.environ.get("CONSOLE_SEARXNG_URL", "http://127.0.0.1:8090")

# Enough for a model to choose from, few enough that the choosing is not the
# expensive part of the turn.
MAX_RESULTS = 8

# A page is read to answer one question, and the answer is near the top of it
# far more often than not. Past this the context costs more than the tail is
# worth.
MAX_PAGE_CHARS = 12_000

# Passages, for when the caller says what it is looking for.
#
# Handing back the first twelve thousand characters of a page answers a
# different question than the one asked: not "what does this say about X" but
# "how does this open". The answer to the first is as likely to be in the
# middle, where nothing reaches it, however the question is reworded.
#
# BM25 over the page's own passages rather than embeddings. The queries an
# agent writes are keyword-shaped -- names, error strings, quoted phrases --
# which is what lexical matching is good at, and the alternative is a model to
# load, a card to load it on, and a second service to keep alive. Passage-level
# selection is also what lets a run read more pages before the context runs
# out, which is the whole point of doing it.
CHUNK_CHARS = 900       # ~512 tokens, at the 1.85 chars per token this text measures
CHUNK_OVERLAP = 120
MAX_PASSAGES = 4        # the opening, plus the three that matched best
MAX_RANK_CHARS = 400_000

TIMEOUT = httpx.Timeout(20.0, connect=5.0)


class Unavailable(RuntimeError):
    """The search service is not running or did not answer."""


async def search(query: str, limit: int = MAX_RESULTS) -> dict:
    """Ask SearXNG, and return only what is worth sending on.

    SearXNG's JSON carries the full engine payload per result -- scores,
    categories, positions, cached URLs, thumbnails. None of it helps a model
    decide which link to read, and all of it costs context, so the fields are
    chosen rather than forwarded.
    """
    params = {"q": query, "format": "json", "language": "auto"}
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.get(f"{BASE}/search", params=params)
            response.raise_for_status()
            payload = response.json()
    except httpx.HTTPError as exc:
        raise Unavailable(f"搜尋服務沒有回應：{exc}") from exc
    except ValueError as exc:
        raise Unavailable("搜尋服務回傳的不是 JSON") from exc

    results = []
    for item in (payload.get("results") or [])[:limit]:
        results.append({
            "title": (item.get("title") or "").strip(),
            "url": item.get("url"),
            "snippet": (item.get("content") or "").strip()[:400],
            # Which engines found it. Two agreeing is a different fact from one.
            "engines": item.get("engines") or [],
            "published": item.get("publishedDate"),
        })

    return {
        "query": payload.get("query") or query,
        "results": results,
        # SearXNG lifts a direct answer out of an engine when there is one --
        # a definition, a conversion, a date. Worth more than the links.
        "answers": payload.get("answers") or [],
    }


class _Text(HTMLParser):
    """Visible text, in reading order.

    A stripped-tags regex was the obvious approach and produces a page whose
    navigation, cookie banner and script bodies are indistinguishable from its
    article. Dropping the elements that are never prose, and keeping the block
    boundaries as newlines, is the difference between a page a model can read
    and a wall it has to guess at.
    """

    SKIP = {"script", "style", "noscript", "template", "svg", "nav", "footer", "form"}
    BLOCK = {
        "p", "div", "section", "article", "li", "tr", "br", "hr",
        "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skipping = 0
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skipping += 1
        if tag == "title":
            self._in_title = True
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skipping:
            self._skipping -= 1
        if tag == "title":
            self._in_title = False
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._in_title and not self.title:
            self.title = data.strip()
        if not self._skipping:
            self.parts.append(data)

    def text(self) -> str:
        joined = "".join(self.parts)
        # Runs of blank lines are what block boundaries leave behind; a page is
        # not more readable for having twenty of them in a row.
        joined = re.sub(r"[ \t ]+", " ", joined)
        return re.sub(r"\n\s*\n\s*", "\n\n", joined).strip()


_WORD = re.compile(r"[a-z0-9]+")
_CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+")


def _terms(text: str) -> list[str]:
    """A query or a passage, reduced to pieces that can be compared.

    Latin runs become lowercased words. CJK runs become overlapping character
    pairs, because Chinese is written without spaces and a segmenter would be a
    dependency, a dictionary and a guess at the language. A pair is close enough
    to a word to match on -- most two-character sequences that recur are real
    terms -- and being wrong about the rest costs nothing, since a term no
    passage shares scores nothing anyway.
    """
    out = _WORD.findall(text.lower())
    for run in _CJK.findall(text):
        out.extend(run[i:i + 2] for i in range(len(run) - 1))
        if len(run) == 1:
            out.append(run)
    return out


def _passages(text: str) -> list[str]:
    """The page in pieces, cut where the writing already cuts it."""
    paragraphs: list[str] = []
    for para in re.split(r"\n{2,}", text):
        para = para.strip()
        # A paragraph longer than a passage is cut on length, since nothing
        # else about it is a boundary.
        while len(para) > CHUNK_CHARS:
            paragraphs.append(para[:CHUNK_CHARS])
            para = para[CHUNK_CHARS:]
        if para:
            paragraphs.append(para)

    out: list[str] = []
    current: list[str] = []
    size = 0
    for para in paragraphs:
        if size and size + len(para) > CHUNK_CHARS:
            out.append("\n\n".join(current))
            # The tail of the passage just closed opens the next one, so a
            # sentence that straddles the boundary is whole in one of them.
            # Snapped forward to the first space, since a slice taken at a
            # fixed width lands mid-word about as often as not; where there is
            # no space to find, as in Chinese, the slice is already a boundary.
            tail = out[-1][-CHUNK_OVERLAP:]
            space = re.search(r"\s", tail)
            if space:
                tail = tail[space.end():]
            current, size = ([tail] if tail else []), len(tail)
        current.append(para)
        size += len(para)
    if current:
        out.append("\n\n".join(current))
    return out


def _rank(passages: list[str], query: str, limit: int) -> tuple[list[int], str]:
    """The passages that answer the query, best first, and why there are none.

    BM25 with the usual constants. Its IDF is computed across this one page's
    passages, a corpus of a few dozen, which sounds like too small a population
    to mean anything -- and is exactly what discounts the words that survive
    into every passage, the breadcrumbs and the cookie line, in favour of the
    ones the page says in only one place.

    Discounts, but does not remove: BM25's smoothed IDF stays positive however
    common a term is, so a query made only of words on every passage still
    scores, and what wins is then whichever passage happens to be shortest. That
    is a ranking with no information in it dressed as a result. Those terms are
    dropped when others remain, and when none do the answer is that the page
    says it everywhere -- which needs a different sentence than never saying it,
    since only one of the two is worth rephrasing for.
    """
    wanted = set(_terms(query))
    if not wanted or not passages:
        return [], "absent"

    tokens = [_terms(p) for p in passages]
    counts = [Counter(t) for t in tokens]
    lengths = [len(t) or 1 for t in tokens]
    average = sum(lengths) / len(lengths)
    carrying: Counter[str] = Counter()
    for token in tokens:
        carrying.update(set(token))

    total = len(passages)
    present = [term for term in wanted if carrying[term]]
    if not present:
        return [], "absent"
    telling = [term for term in present if carrying[term] < total] if total > 1 else present
    if not telling:
        return [], "everywhere"

    k1, b = 1.2, 0.75
    scored: list[tuple[float, int]] = []
    for index, count in enumerate(counts):
        score = 0.0
        for term in telling:
            seen = count.get(term, 0)
            if not seen:
                continue
            idf = math.log(1 + (total - carrying[term] + 0.5) / (carrying[term] + 0.5))
            norm = k1 * (1 - b + b * lengths[index] / average)
            score += idf * seen * (k1 + 1) / (seen + norm)
        if score > 0:
            scored.append((score, index))

    # Ties go to whichever came first, so the same page and query always
    # produce the same passages.
    scored.sort(key=lambda pair: (-pair[0], pair[1]))
    return [index for _, index in scored[:limit]], ""


def _assemble(passages: list[str], chosen: list[int]) -> str:
    """The chosen passages in the order they were written, gaps marked.

    Score order would arrive as a pile of quotations. A page argues in sequence
    and the model is about to be asked what it says, so reading order is the
    part worth keeping. The marker is there so that a jump reads as a jump
    rather than as a non sequitur.
    """
    keep = sorted(set(chosen))
    out: list[str] = []
    for position, index in enumerate(keep):
        if position and index != keep[position - 1] + 1:
            out.append("[…]")
        out.append(passages[index])
    return "\n\n".join(out)


async def read(url: str, query: str = "") -> dict:
    """Fetch one page and return its text, or the part of it that was asked for.

    Only http and https, and only what the response says it is. A model that
    has been handed a list of links will occasionally follow one to a PDF or a
    zip, and answering with the first twelve thousand characters of a binary is
    worse than saying what it was.

    With a query, what comes back is the passages that match it plus the page's
    opening. Without one, the opening is all there is to give -- and that is the
    right answer for "what is this page", which is a real question.
    """
    if not re.match(r"^https?://", url, re.I):
        raise Unavailable("只接受 http 或 https 的網址")

    try:
        async with httpx.AsyncClient(
            timeout=TIMEOUT, follow_redirects=True,
            headers={"user-agent": "Mozilla/5.0 (compatible; TenkStack/1.0)"},
        ) as client:
            response = await client.get(url)
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise Unavailable(f"讀不到這個網址：{exc}") from exc

    kind = (response.headers.get("content-type") or "").split(";")[0].strip()
    if kind and not (kind.startswith("text/") or kind in {
        "application/json", "application/xhtml+xml", "application/xml",
    }):
        return {"url": str(response.url), "content_type": kind, "text": "",
                "note": f"這是 {kind}，不是可以讀的文字內容。"}

    body = response.text
    if kind in {"text/html", "application/xhtml+xml"} or "<html" in body[:2000].lower():
        parser = _Text()
        parser.feed(body)
        text, title = parser.text(), parser.title
    else:
        text, title = body, ""

    found = {
        "url": str(response.url),
        "title": title,
        "content_type": kind,
        "chars_total": len(text),
    }

    if query.strip() and text:
        passages = _passages(text[:MAX_RANK_CHARS])
        # One short of the limit: the opening is added below and is worth more
        # than a fourth match, being the only place a page says what it is. A
        # passage lifted out of the middle cannot say that for itself.
        chosen, reason = _rank(passages, query, MAX_PASSAGES - 1)
        if chosen:
            keep = sorted({0, *chosen})
            body = _assemble(passages, keep)
            return {
                **found, "text": body, "query": query, "matched": True,
                "passages_used": len(keep), "passages_total": len(passages),
                "truncated": len(body) < len(text),
            }
        # Nothing to choose between. Falling back to the opening beats
        # returning nothing, but it has to be said which of the two happened --
        # a model that thinks it read the page will not rephrase and try again,
        # and one told "everywhere" should not rephrase at all.
        return {
            **found, "text": text[:MAX_PAGE_CHARS], "query": query,
            "matched": False, "reason": reason,
            "truncated": len(text) > MAX_PAGE_CHARS,
        }

    return {
        **found,
        "text": text[:MAX_PAGE_CHARS],
        "truncated": len(text) > MAX_PAGE_CHARS,
    }


async def available() -> bool:
    """Whether the search service is up, for deciding whether to offer the tool
    at all. A tool that is offered and then always fails is worse than one that
    was never mentioned."""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(3.0)) as client:
            response = await client.get(f"{BASE}/healthz")
            return response.status_code == 200
    except httpx.HTTPError:
        return False
