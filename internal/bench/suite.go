package bench

import (
	"embed"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/NoobBandi/TenkStack/internal/api"
	"github.com/NoobBandi/TenkStack/internal/schema"
)

// Suite v1 is built in until the workshop hands suites out (D33); it is the
// same BenchSuite shape the workshop will send, so the runner does not care
// where it came from. The prompts and the filler are original text written
// for the suite, safe to publish with it.
//
//go:embed suite/v1/*
var suiteFiles embed.FS

// Prompts carries the depth filler beside the questions, under these keys:
// the workshop needs the filler as much as the prompts for two machines'
// numbers to be comparable.
const (
	fillerPrefix = "filler-"
	// Code is padded with English prose: there is no third language, and
	// what fills the context matters less than how much of it there is.
	fillerFallback = "en"
)

// headers introduce the filler, so a model reads it as unrelated
// background rather than something the task asks about.
var headers = map[string]string{
	"en": "Background reading (not related to the task below):\n\n",
	"zh": "背景資料（與下方題目無關）：\n\n",
}

// SuiteV1 is the built-in suite.
func SuiteV1() schema.BenchSuite {
	raw, err := suiteFiles.ReadFile("suite/v1/suite.json")
	if err != nil {
		panic(err)
	}
	var s schema.BenchSuite
	if err := json.Unmarshal(raw, &s); err != nil {
		panic(fmt.Sprintf("suite v1: %v", err))
	}
	s.Prompts = map[string]string{}
	for _, name := range []string{"zh", "en", "code", "filler-zh", "filler-en"} {
		text, err := suiteFiles.ReadFile("suite/v1/" + name + ".txt")
		if err != nil {
			panic(err)
		}
		s.Prompts[name] = strings.TrimSpace(string(text))
	}
	return s
}

// fillerFor is the filler a case's content is padded with.
func fillerFor(s schema.BenchSuite, content string) (lang, text string) {
	if t, ok := s.Prompts[fillerPrefix+content]; ok {
		return content, t
	}
	return fillerFallback, s.Prompts[fillerPrefix+fillerFallback]
}

func headerFor(lang string) string {
	if h, ok := headers[lang]; ok {
		return h
	}
	return headers[fillerFallback]
}

// contextHeadroom is kept free beyond the depth and the output: the chat
// template and the unique prefix add a little, and a request that runs into
// the context's end fails rather than measures.
//
// Suite v1's depths beyond 1k are their nominal size less 512 -- 32k is
// 32,256 tokens -- so that depth, the output and this headroom fit in a
// context opened at exactly that size: a model started with 128K runs the
// 128k case rather than skipping it by a few hundred tokens.
const contextHeadroom = 128

// contextLimit is how many tokens one request may use, 0 when unknown. A
// per-slot size, where the engine splits its context, is the real limit.
func contextLimit(t schema.Tuning) int {
	if t.KVCache != nil && t.KVCache.PerSlotContext != nil && *t.KVCache.PerSlotContext > 0 {
		return *t.KVCache.PerSlotContext
	}
	return t.ContextLength
}

// Select is the cases of a tier, and those left out as "id: reason". A
// case deeper than limit, the tokens one request may use, is left out; 0
// is unknown and leaves none out.
func Select(s schema.BenchSuite, tier string, limit int) (cases []schema.BenchCase, skipped []string) {
	for _, c := range s.Cases {
		if !slices.Contains(c.Tiers, tier) {
			continue
		}
		if limit > 0 && c.DepthTokens+s.OutputTokens+contextHeadroom > limit {
			skipped = append(skipped, fmt.Sprintf("%s: 超過模型的上下文長度（%d）", c.ID, limit))
			continue
		}
		cases = append(cases, c)
	}
	return cases, skipped
}

// repeatsFor: a quick run measures each case once (D32).
func repeatsFor(c schema.BenchCase, tier string) int {
	if tier == api.BenchQuick || c.Repeats < 1 {
		return 1
	}
	return c.Repeats
}

// condition is what makes two cases the same measurement. Suite v1 names
// one condition three times (depth-1k, conc-1, content-en: 1k, one stream,
// English) so each axis reads complete on its own; it is measured once.
type condition struct {
	depth, concurrency, repeats int
	content, prompt             string
}

func conditionOf(c schema.BenchCase, tier string) condition {
	return condition{c.DepthTokens, max(c.Concurrency, 1), repeatsFor(c, tier), c.Content, c.PromptRef}
}
