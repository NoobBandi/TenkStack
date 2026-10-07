package bench

import (
	"slices"
	"sort"
	"time"

	"github.com/NoobBandi/TenkStack/internal/schema"
)

// Group is a llama-swap group as config.yaml declares it, with llama-swap's
// defaults applied by whoever reads it: swap and exclusive true,
// persistent false.
type Group struct {
	Name       string
	Swap       bool // one member resident at a time
	Exclusive  bool // loading a member unloads every other group
	Persistent bool // never unloaded by another group's exclusivity
	Members    []string
}

// defaultGroup is where llama-swap puts a model no group names.
var defaultGroup = Group{Name: "(default)", Swap: true, Exclusive: true}

func groupOf(groups []Group, model string) Group {
	for _, g := range groups {
		if slices.Contains(g.Members, model) {
			return g
		}
	}
	return defaultGroup
}

// Unloads is which resident models llama-swap will stop to load model:
// the other members of its group when the group swaps, and everything
// outside the group, persistent groups apart, when it is exclusive (D28).
func Unloads(groups []Group, running []string, model string) []string {
	if slices.Contains(running, model) {
		return []string{}
	}
	mine := groupOf(groups, model)
	out := []string{}
	for _, other := range running {
		g := groupOf(groups, other)
		same := g.Name == mine.Name
		if (same && mine.Swap) || (!same && mine.Exclusive && !g.Persistent) {
			out = append(out, other)
		}
	}
	sort.Strings(out)
	return out
}

// A rough cost model for the estimate: the speeds of a mid-sized model on
// one card. Only the confirmation and the pause message use it, and once a
// model has been measured its last run is used instead.
const (
	assumedPrefillTPS = 1500.0
	assumedGenTPS     = 25.0
	assumedProbeS     = 3.0
	assumedColdS      = 180.0
)

// Estimate is how long a run of these cases should take, in seconds.
func Estimate(s schema.BenchSuite, tier string, cases []schema.BenchCase, loaded bool) int {
	total := float64(max(s.Warmup, 1)) * (512/assumedPrefillTPS + float64(s.OutputTokens)/assumedGenTPS)
	seen := map[condition]bool{}
	langs := map[string]bool{}
	prompts := map[string]bool{}
	for _, c := range cases {
		cond := conditionOf(c, tier)
		if seen[cond] {
			continue
		}
		seen[cond] = true
		lang, _ := fillerFor(s, c.Content)
		langs[lang] = true
		prompts[c.PromptRef+"|"+lang] = true
		one := float64(c.DepthTokens)/assumedPrefillTPS + float64(s.OutputTokens)/assumedGenTPS
		// More streams share the card: each one slower, the round longer.
		one *= 1 + 0.15*float64(cond.concurrency-1)
		total += one * float64(cond.repeats)
	}
	total += assumedProbeS * float64(len(langs)+len(prompts))
	if !loaded {
		total += assumedColdS
	}
	return int(total + 0.5)
}

// drainTimeout is how long a run waits for requests in flight before the
// owner is offered to force the start (Q13); drainGrace how much longer it
// then waits for an answer before it cancels itself.
const (
	drainTimeout = 2 * time.Minute
	drainGrace   = 2 * time.Minute
)

// drainPoll is how often a drain looks; requests end on their own schedule
// and nothing signals it more cheaply than a counter.
var drainPoll = 250 * time.Millisecond

// hardLimit is how long the pause may last whatever happens: twice the
// estimate (§7.4), but never less than the estimate plus a slow model load,
// since an estimate's cold start is a guess and llama-swap allows a load
// 15 minutes.
func hardLimit(estimate time.Duration) time.Duration {
	return max(2*estimate, estimate+15*time.Minute)
}
