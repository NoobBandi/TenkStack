// Package search asks SearXNG and reads pages. On the server because the
// sandbox's frame has no origin and search engines refuse Origin: null;
// SearXNG because it needs no account, key or quota.
package search

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"golang.org/x/net/html"
	"golang.org/x/net/html/charset"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
)

const (
	maxResults   = 8
	maxPageChars = 12000
	chunkChars   = 900 // ~512 tokens at the 1.85 chars per token this text measures
	chunkOverlap = 120
	maxPassages  = 4 // the opening, plus the three that matched best
	maxRankChars = 400000
)

// Unavailable is the search service not running or a page not readable.
type Unavailable struct{ Msg string }

func (e *Unavailable) Error() string { return e.Msg }

type Client struct {
	Base string
	http *http.Client
}

func New(base string) *Client {
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	return &Client{Base: base, http: &http.Client{Timeout: 20 * time.Second,
		Transport: &http.Transport{DialContext: dialer.DialContext}}}
}

// Search returns only what is worth sending on: SearXNG's per-result
// engine payload costs context and helps nobody choose a link.
func (c *Client) Search(ctx context.Context, query string, limit int) (api.SearchResponse, error) {
	q := url.Values{"q": {query}, "format": {"json"}, "language": {"auto"}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Base+"/search?"+q.Encode(), nil)
	if err != nil {
		return api.SearchResponse{}, &Unavailable{"搜尋服務沒有回應：" + err.Error()}
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return api.SearchResponse{}, &Unavailable{"搜尋服務沒有回應：" + err.Error()}
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return api.SearchResponse{}, &Unavailable{fmt.Sprintf("搜尋服務沒有回應：HTTP %d", resp.StatusCode)}
	}
	var payload struct {
		Query   any              `json:"query"`
		Results []map[string]any `json:"results"`
		Answers []any            `json:"answers"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return api.SearchResponse{}, &Unavailable{"搜尋服務回傳的不是 JSON"}
	}
	out := api.SearchResponse{Query: payload.Query, Results: []api.SearchHit{}, Answers: payload.Answers}
	if out.Query == nil || out.Query == "" {
		out.Query = query
	}
	if out.Answers == nil {
		out.Answers = []any{}
	}
	for i, item := range payload.Results {
		if i >= limit {
			break
		}
		title, _ := item["title"].(string)
		content, _ := item["content"].(string)
		snippet := strings.TrimSpace(content)
		if r := []rune(snippet); len(r) > 400 {
			snippet = string(r[:400])
		}
		engines, _ := item["engines"].([]any)
		if engines == nil {
			engines = []any{}
		}
		out.Results = append(out.Results, api.SearchHit{
			Title: strings.TrimSpace(title), URL: item["url"], Snippet: snippet,
			Engines: engines, Published: item["publishedDate"],
		})
	}
	return out, nil
}

// Available says whether the service is up, so the tool is offered only
// when it can work.
func (c *Client) Available(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Base+"/healthz", nil)
	if err != nil {
		return false
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == 200
}

// extractor is visible text in reading order: elements that are never
// prose are dropped, block boundaries become newlines, a block that is
// almost entirely link text is a menu, and inside a formula only the TeX
// annotation is kept.
type extractor struct {
	blocks   []string
	title    string
	buffer   []string
	chars    int
	linked   int
	skipping int
	anchor   int
	math     int
	tex      int
	inTitle  bool
}

var (
	skipTags  = map[string]bool{"script": true, "style": true, "noscript": true, "template": true, "svg": true, "nav": true, "footer": true, "form": true}
	blockTags = map[string]bool{"p": true, "div": true, "section": true, "article": true, "li": true, "tr": true, "br": true, "hr": true,
		"h1": true, "h2": true, "h3": true, "h4": true, "h5": true, "h6": true, "blockquote": true, "pre": true}
	linkDensity = 0.8
)

func (e *extractor) flush() {
	text := strings.TrimSpace(strings.Join(e.buffer, ""))
	chars, linked := e.chars, e.linked
	e.buffer, e.chars, e.linked = nil, 0, 0
	if text == "" {
		return
	}
	if chars > 0 && float64(linked)/float64(chars) >= linkDensity {
		return
	}
	e.blocks = append(e.blocks, text)
}

func (e *extractor) start(tag string) {
	if blockTags[tag] {
		e.flush()
	}
	if skipTags[tag] {
		e.skipping++
	}
	switch tag {
	case "a":
		e.anchor++
	case "math":
		e.math++
	case "annotation":
		e.tex++
	case "title":
		e.inTitle = true
	}
}

func (e *extractor) end(tag string) {
	if blockTags[tag] {
		e.flush()
	}
	if skipTags[tag] && e.skipping > 0 {
		e.skipping--
	}
	switch tag {
	case "a":
		if e.anchor > 0 {
			e.anchor--
		}
	case "math":
		if e.math > 0 {
			e.math--
		}
	case "annotation":
		if e.tex > 0 {
			e.tex--
		}
	case "title":
		e.inTitle = false
	}
}

func (e *extractor) data(text string) {
	if e.inTitle && e.title == "" {
		e.title = strings.TrimSpace(text)
	}
	if e.skipping > 0 {
		return
	}
	if e.math > 0 && e.tex == 0 {
		return
	}
	e.buffer = append(e.buffer, text)
	weight := len(strings.TrimSpace(text))
	e.chars += weight
	if e.anchor > 0 {
		e.linked += weight
	}
}

var (
	spaces     = regexp.MustCompile("[ \t ]+")
	blankLines = regexp.MustCompile(`\n\s*\n\s*`)
)

func (e *extractor) text() string {
	e.flush()
	joined := strings.Join(e.blocks, "\n\n")
	joined = spaces.ReplaceAllString(joined, " ")
	return strings.TrimSpace(blankLines.ReplaceAllString(joined, "\n\n"))
}

func extract(body string) (string, string) {
	e := &extractor{}
	z := html.NewTokenizer(strings.NewReader(body))
	for {
		switch z.Next() {
		case html.ErrorToken:
			return e.text(), e.title
		case html.StartTagToken:
			name, _ := z.TagName()
			e.start(string(name))
		case html.EndTagToken:
			name, _ := z.TagName()
			e.end(string(name))
		case html.SelfClosingTagToken:
			name, _ := z.TagName()
			e.start(string(name))
			e.end(string(name))
		case html.TextToken:
			e.data(html.UnescapeString(string(z.Text())))
		}
	}
}

var (
	wordRun = regexp.MustCompile(`[a-z0-9]+`)
	cjkRun  = regexp.MustCompile("[㐀-䶿一-鿿぀-ヿ가-힯]+")
)

// terms reduces text to comparable pieces: lowercased Latin words, and
// overlapping character pairs for CJK, which is written without spaces.
func terms(text string) []string {
	out := wordRun.FindAllString(strings.ToLower(text), -1)
	for _, run := range cjkRun.FindAllString(text, -1) {
		r := []rune(run)
		for i := 0; i+1 < len(r); i++ {
			out = append(out, string(r[i:i+2]))
		}
		if len(r) == 1 {
			out = append(out, run)
		}
	}
	return out
}

var paragraphSplit = regexp.MustCompile(`\n{2,}`)

// passages cuts the page where the writing already cuts it, with the tail
// of one passage opening the next so a straddling sentence is whole in one.
func passages(text string) []string {
	var paragraphs []string
	for _, para := range paragraphSplit.Split(text, -1) {
		para = strings.TrimSpace(para)
		for len([]rune(para)) > chunkChars {
			r := []rune(para)
			paragraphs = append(paragraphs, string(r[:chunkChars]))
			para = string(r[chunkChars:])
		}
		if para != "" {
			paragraphs = append(paragraphs, para)
		}
	}
	var out []string
	var current []string
	size := 0
	for _, para := range paragraphs {
		if size > 0 && size+len([]rune(para)) > chunkChars {
			out = append(out, strings.Join(current, "\n\n"))
			last := []rune(out[len(out)-1])
			tail := last
			if len(last) > chunkOverlap {
				tail = last[len(last)-chunkOverlap:]
			}
			tailStr := string(tail)
			if loc := regexp.MustCompile(`\s`).FindStringIndex(tailStr); loc != nil {
				tailStr = tailStr[loc[1]:]
			}
			current, size = nil, 0
			if tailStr != "" {
				current, size = []string{tailStr}, len([]rune(tailStr))
			}
		}
		current = append(current, para)
		size += len([]rune(para))
	}
	if len(current) > 0 {
		out = append(out, strings.Join(current, "\n\n"))
	}
	return out
}

// rank is BM25 over this one page's passages. Terms on every passage are
// dropped when others remain; when none do, the page says it everywhere,
// which needs a different sentence than never saying it.
func rank(list []string, query string, limit int) ([]int, string) {
	wanted := map[string]bool{}
	for _, t := range terms(query) {
		wanted[t] = true
	}
	if len(wanted) == 0 || len(list) == 0 {
		return nil, "absent"
	}
	tokens := make([][]string, len(list))
	counts := make([]map[string]int, len(list))
	lengths := make([]float64, len(list))
	carrying := map[string]int{}
	total := 0.0
	for i, p := range list {
		tokens[i] = terms(p)
		counts[i] = map[string]int{}
		seen := map[string]bool{}
		for _, t := range tokens[i] {
			counts[i][t]++
			seen[t] = true
		}
		for t := range seen {
			carrying[t]++
		}
		lengths[i] = float64(len(tokens[i]))
		if lengths[i] == 0 {
			lengths[i] = 1
		}
		total += lengths[i]
	}
	average := total / float64(len(list))
	var present, telling []string
	for t := range wanted {
		if carrying[t] > 0 {
			present = append(present, t)
		}
	}
	if len(present) == 0 {
		return nil, "absent"
	}
	if len(list) > 1 {
		for _, t := range present {
			if carrying[t] < len(list) {
				telling = append(telling, t)
			}
		}
	} else {
		telling = present
	}
	if len(telling) == 0 {
		return nil, "everywhere"
	}
	k1, b := 1.2, 0.75
	type scored struct {
		score float64
		index int
	}
	var results []scored
	n := float64(len(list))
	for i := range list {
		score := 0.0
		for _, t := range telling {
			seen := float64(counts[i][t])
			if seen == 0 {
				continue
			}
			df := float64(carrying[t])
			idf := math.Log(1 + (n-df+0.5)/(df+0.5))
			norm := k1 * (1 - b + b*lengths[i]/average)
			score += idf * seen * (k1 + 1) / (seen + norm)
		}
		if score > 0 {
			results = append(results, scored{score, i})
		}
	}
	sort.SliceStable(results, func(i, j int) bool {
		if results[i].score != results[j].score {
			return results[i].score > results[j].score
		}
		return results[i].index < results[j].index
	})
	out := []int{}
	for i, r := range results {
		if i >= limit {
			break
		}
		out = append(out, r.index)
	}
	return out, ""
}

// assemble is the chosen passages in the order they were written, gaps
// marked so a jump reads as a jump.
func assemble(list []string, chosen []int) string {
	keep := append([]int{}, chosen...)
	sort.Ints(keep)
	var out []string
	prev := -2
	for i, index := range keep {
		if i > 0 && index == prev {
			continue
		}
		if i > 0 && index != prev+1 {
			out = append(out, "[…]")
		}
		out = append(out, list[index])
		prev = index
	}
	return strings.Join(out, "\n\n")
}

func truncate(text string, n int) (string, bool) {
	r := []rune(text)
	if len(r) > n {
		return string(r[:n]), true
	}
	return text, false
}

// Read fetches one page and returns its text, or the passages that answer
// the query plus the opening. Only http and https, and only what the
// response says it is.
func (c *Client) Read(ctx context.Context, pageURL, query string) (map[string]any, error) {
	if !regexp.MustCompile(`(?i)^https?://`).MatchString(pageURL) {
		return nil, &Unavailable{"只接受 http 或 https 的網址"}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pageURL, nil)
	if err != nil {
		return nil, &Unavailable{"讀不到這個網址：" + err.Error()}
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; TenkStack/1.0)")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &Unavailable{"讀不到這個網址：" + err.Error()}
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, &Unavailable{fmt.Sprintf("讀不到這個網址：HTTP %d", resp.StatusCode)}
	}
	kind := strings.TrimSpace(strings.SplitN(resp.Header.Get("Content-Type"), ";", 2)[0])
	final := resp.Request.URL.String()
	if kind != "" && !strings.HasPrefix(kind, "text/") && kind != "application/json" && kind != "application/xhtml+xml" && kind != "application/xml" {
		return map[string]any{"url": final, "content_type": kind, "text": "", "note": fmt.Sprintf("這是 %s，不是可以讀的文字內容。", kind)}, nil
	}
	reader, err := charset.NewReader(resp.Body, resp.Header.Get("Content-Type"))
	if err != nil {
		reader = resp.Body
	}
	raw, err := io.ReadAll(io.LimitReader(reader, 64<<20))
	if err != nil && len(raw) == 0 {
		return nil, &Unavailable{"讀不到這個網址：" + err.Error()}
	}
	body := string(raw)
	var text, title string
	head, _ := truncate(body, 2000)
	if kind == "text/html" || kind == "application/xhtml+xml" || strings.Contains(strings.ToLower(head), "<html") {
		text, title = extract(body)
	} else {
		text = body
	}
	found := map[string]any{"url": final, "title": title, "content_type": kind, "chars_total": len([]rune(text))}

	if strings.TrimSpace(query) != "" && text != "" {
		limited, _ := truncate(text, maxRankChars)
		list := passages(limited)
		chosen, reason := rank(list, query, maxPassages-1)
		if len(chosen) > 0 {
			keep := append([]int{0}, chosen...)
			body := assemble(list, keep)
			set := map[int]bool{}
			for _, k := range keep {
				set[k] = true
			}
			found["text"] = body
			found["query"] = query
			found["matched"] = true
			found["passages_used"] = len(set)
			found["passages_total"] = len(list)
			found["truncated"] = len([]rune(body)) < len([]rune(text))
			return found, nil
		}
		short, cut := truncate(text, maxPageChars)
		found["text"] = short
		found["query"] = query
		found["matched"] = false
		found["reason"] = reason
		found["truncated"] = cut
		return found, nil
	}
	short, cut := truncate(text, maxPageChars)
	found["text"] = short
	found["truncated"] = cut
	return found, nil
}

var _ = errors.New
