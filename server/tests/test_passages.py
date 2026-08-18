"""What read(url, query) selects, checked without a network.

Run: .venv/bin/python tests/test_passages.py

These are the parts that decide what a model gets to read, and every one of
them is a pure function over text -- so the failures worth catching are all
reachable from a fixed string, and none of them need a page to exist.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.search import (  # noqa: E402
    CHUNK_CHARS, CHUNK_OVERLAP, MAX_PASSAGES, _Text, _assemble, _passages, _rank, _terms,
)


def extract(html):
    parser = _Text()
    parser.feed(html)
    return parser.text()

failures = []


def check(name, got, want):
    if got == want:
        print("  PASS  %s" % name)
    else:
        failures.append(name)
        print("  FAIL  %s\n        got  %r\n        want %r" % (name, got, want))


def check_that(name, condition, detail=""):
    check(name, bool(condition) or detail or False, True)


print("extraction")
check("a block of nothing but links is a menu",
      extract("<ul><li><a href=/a>Español</a></li><li><a href=/b>日本語</a></li></ul>"
              "<p>The article itself.</p>"),
      "The article itself.")
check("a paragraph that cites things is not",
      extract("<p>BM25 was developed by <a href=/r>Robertson</a> and others "
              "over several years of work on probabilistic retrieval.</p>"),
      "BM25 was developed by Robertson and others over several years of work "
      "on probabilistic retrieval.")
check("scripts, navigation and footers stay out",
      extract("<nav><p>Home</p></nav><script>var x=1</script>"
              "<p>Body.</p><footer><p>Contact us</p></footer>"),
      "Body.")
check("a formula arrives once, as TeX",
      extract("<p>The score is <span><math><semantics><mrow><mi>k</mi><mn>1</mn></mrow>"
              "<annotation encoding=\"application/x-tex\">{k_1}</annotation>"
              "</semantics></math></span> here.</p>"),
      "The score is {k_1} here.")
check("the title is taken from the head",
      (lambda t: (t.feed("<title>Okapi BM25</title><p>x</p>"), t.title)[1])(_Text()),
      "Okapi BM25")

print("\nterms")
check("latin lowercases and splits", _terms("BM25 Ranking, k1=1.2"),
      ["bm25", "ranking", "k1", "1", "2"])
check("cjk becomes overlapping pairs", _terms("質數分布"), ["質數", "數分", "分布"])
check("a lone cjk character survives", _terms("貓"), ["貓"])
check("mixed keeps both", _terms("用 numpy 算質數"), ["numpy", "用", "算質", "質數"])

print("\npassages")
long_text = "\n\n".join("段落%d " % i + "字" * 300 for i in range(12))
cut = _passages(long_text)
check_that("nothing exceeds the chunk plus its overlap",
           all(len(p) <= CHUNK_CHARS + CHUNK_OVERLAP + 8 for p in cut),
           "longest was %d" % max(len(p) for p in cut))
check_that("consecutive passages overlap",
           cut[0][-CHUNK_OVERLAP:] in cut[1],
           "tail of the first is not in the second")
check_that("everything is covered", "段落11" in "".join(cut))
one_long = "字" * (CHUNK_CHARS * 3)
check_that("a paragraph longer than a passage is still cut",
           all(len(p) <= CHUNK_CHARS + CHUNK_OVERLAP + 8 for p in _passages(one_long)))

print("\nranking")
NAV = "首頁 關於 聯絡我們 隱私權政策"
page = [
    "%s\n\nTenkStack 是一套自架的控制台。" % NAV,
    "%s\n\n安裝方式很簡單，照著步驟做就好。" % NAV,
    "%s\n\n效能方面，B70 實測記憶體頻寬是 585 GB/s。" % NAV,
    "%s\n\n授權條款是 MIT。" % NAV,
]
check("the passage that says it, not the ones that do not",
      _rank(page, "記憶體頻寬", 3)[0][0], 2)
check("a word on every passage discriminates nothing",
      _rank(page, "隱私權政策", 3), ([], "everywhere"))
check("english query, english page",
      _rank(["nothing here", "BM25 uses k1 and b", "unrelated"], "BM25 k1", 2)[0][0], 1)
check("a query the page never says returns nothing",
      _rank(page, "量子力學", 3), ([], "absent"))
check("boilerplate alongside a real term is ignored, not followed",
      _rank(page, "隱私權政策 記憶體頻寬", 3)[0][0], 2)

print("\nassembly")
check("document order, not score order", _assemble(["a", "b", "c", "d"], [3, 0]),
      "a\n\n[…]\n\nd")
check("adjacent passages are not marked", _assemble(["a", "b", "c"], [0, 1]), "a\n\nb")
check("one passage needs no marker", _assemble(["a", "b"], [1]), "b")

print("\nwhat read() would assemble")
chosen, _ = _rank(page, "記憶體頻寬", MAX_PASSAGES - 1)
keep = sorted({0, *chosen})
check("the opening always comes along", keep[0], 0)
check("and the match with it", 2 in keep, True)
check("at most the limit", len(keep) <= MAX_PASSAGES, True)

print()
if failures:
    print("%d failed: %s" % (len(failures), ", ".join(failures)))
    sys.exit(1)
print("all passed")
