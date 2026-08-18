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
import os
import re
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


async def read(url: str) -> dict:
    """Fetch one page and return its text.

    Only http and https, and only what the response says it is. A model that
    has been handed a list of links will occasionally follow one to a PDF or a
    zip, and answering with the first twelve thousand characters of a binary is
    worse than saying what it was.
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

    truncated = len(text) > MAX_PAGE_CHARS
    return {
        "url": str(response.url),
        "title": title,
        "content_type": kind,
        "text": text[:MAX_PAGE_CHARS],
        "truncated": truncated,
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
