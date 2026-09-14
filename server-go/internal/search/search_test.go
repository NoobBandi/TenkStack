package search

import (
	"strings"
	"testing"
)

func TestExtractDropsMenusAndKeepsTeX(t *testing.T) {
	page := `<html><head><title> Page </title><style>p{}</style></head><body>
<nav><a href="/">Home</a><a href="/x">About</a></nav>
<div><a href="/a">one</a> <a href="/b">two</a> <a href="/c">three</a></div>
<p>Real prose with a <a href="/q">citation</a> in it, long enough to count.</p>
<p><math><mi>x</mi><annotation>x^2</annotation></math></p>
<script>var x = 1;</script>
</body></html>`
	text, title := extract(page)
	if title != "Page" {
		t.Errorf("title = %q", title)
	}
	if strings.Contains(text, "Home") || strings.Contains(text, "one two three") {
		t.Errorf("menu survived:\n%s", text)
	}
	if !strings.Contains(text, "Real prose") || !strings.Contains(text, "x^2") || strings.Contains(text, "var x") {
		t.Errorf("text = %q", text)
	}
}

func TestTermsHandleCJK(t *testing.T) {
	got := terms("Hello 世界和平 x")
	want := []string{"hello", "x", "世界", "界和", "和平"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("terms = %v", got)
	}
}

func TestRankPrefersTheTellingPassage(t *testing.T) {
	list := []string{"the site header appears everywhere", "the site header and the widget install steps", "the site header again"}
	chosen, reason := rank(list, "widget install", 2)
	if reason != "" || len(chosen) != 1 || chosen[0] != 1 {
		t.Errorf("chosen = %v reason = %q", chosen, reason)
	}
	if _, reason := rank(list, "site header", 2); reason != "everywhere" {
		t.Errorf("reason = %q", reason)
	}
	if _, reason := rank(list, "zebra", 2); reason != "absent" {
		t.Errorf("reason = %q", reason)
	}
	if got := assemble(list, []int{2, 0}); got != "the site header appears everywhere\n\n[…]\n\nthe site header again" {
		t.Errorf("assemble = %q", got)
	}
}

func TestPassagesOverlap(t *testing.T) {
	long := strings.Repeat("word ", 300) // 1500 chars, cut on length
	list := passages(long + "\n\nsecond paragraph")
	if len(list) < 2 {
		t.Fatalf("got %d passages", len(list))
	}
	if !strings.HasPrefix(list[1], "word") {
		t.Errorf("overlap tail did not snap to a word: %q", list[1][:20])
	}
}
