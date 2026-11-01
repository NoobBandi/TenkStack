package bench

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/NoobBandi/TenkStack/internal/api"
	"github.com/NoobBandi/TenkStack/internal/schema"
)

// Suite v1 is built in, as a BenchSuite like any other, so the runner does
// not care where a suite came from. The prompts and the filler are original
// text written for the suite, safe to publish with it.
//
//go:embed suite/v1/*
var suiteFiles embed.FS

// Prompts carries the depth filler beside the questions, under these keys:
// two machines' numbers are comparable only when both the prompts and the
// filler are the same.
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

// Choice is what a run measures: a tier's cases, or for api.BenchCustom
// the ones a person picked, each once or as often as the full tier.
type Choice struct {
	Tier    string
	Cases   []string // api.BenchCustom: the case ids picked
	Repeats int      // api.BenchCustom: 1 measures each once, 0 as the suite says
}

// baseCases are in every custom run whether picked or not: one person,
// 1k, English, the report's headline and what every comparison in it -- a
// depth's slowdown, a crowd's speedup, a content's rate -- is against.
// They are one condition under each block's name, measured once, so the
// blocks a run adds to each have their first row.
var baseCases = []string{"depth-1k", "conc-1", "content-en"}

// Check says what is wrong with a choice for this suite, nil when nothing.
func (ch Choice) Check(s schema.BenchSuite) error {
	switch ch.Tier {
	case api.BenchQuick, api.BenchFull:
		return nil
	case api.BenchCustom:
	default:
		return errors.New("tier 只能是 quick、full 或 custom")
	}
	if ch.Repeats != 0 && ch.Repeats != 1 {
		return errors.New("repeats 只能是 0（照完整檔）或 1")
	}
	for _, id := range ch.Cases {
		if !slices.ContainsFunc(s.Cases, func(c schema.BenchCase) bool { return c.ID == id }) {
			return fmt.Errorf("沒有 %s 這個測試項目", id)
		}
	}
	return nil
}

// Same says whether two choices measure the same thing.
func (ch Choice) Same(o Choice) bool {
	if ch.Tier != o.Tier {
		return false
	}
	if ch.Tier != api.BenchCustom {
		return true
	}
	a, b := slices.Clone(ch.Cases), slices.Clone(o.Cases)
	slices.Sort(a)
	slices.Sort(b)
	return ch.Repeats == o.Repeats && slices.Equal(slices.Compact(a), slices.Compact(b))
}

func (ch Choice) has(c schema.BenchCase) bool {
	if ch.Tier == api.BenchCustom {
		return slices.Contains(baseCases, c.ID) || slices.Contains(ch.Cases, c.ID)
	}
	return slices.Contains(c.Tiers, ch.Tier)
}

// Select is the cases of a choice, and those left out as "id: reason". A
// case deeper than limit, the tokens one request may use, is left out; 0
// is unknown and leaves none out.
func Select(s schema.BenchSuite, ch Choice, limit int) (cases []schema.BenchCase, skipped []string) {
	for _, c := range s.Cases {
		if !ch.has(c) {
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

// repeatsFor: a quick run measures each case once, and so does a
// custom one asked to.
func repeatsFor(c schema.BenchCase, ch Choice) int {
	if ch.Tier == api.BenchQuick || (ch.Tier == api.BenchCustom && ch.Repeats == 1) || c.Repeats < 1 {
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

func conditionOf(c schema.BenchCase, ch Choice) condition {
	return condition{c.DepthTokens, max(c.Concurrency, 1), repeatsFor(c, ch), c.Content, c.PromptRef}
}
