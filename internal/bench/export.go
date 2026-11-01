package bench

import (
	"path"
	"strings"
	"time"

	"github.com/NoobBandi/TenkStack/internal/schema"
)

// Assemble is the submission for a finished run: what was measured,
// with the Description's account of the machine, model, engine and
// parameters beside it. Nothing local goes in -- the launch command stays
// on the Description -- and Export scrubs it again on the way out.
func Assemble(s schema.BenchSuite, d Description, version, tier string, o Outcome, res schema.Resources,
	started time.Time, duration time.Duration, clean bool) schema.BenchSubmission {
	unrecognized := d.Unrecognized
	if unrecognized == nil {
		unrecognized = []string{}
	}
	if res.VRAMPeakMiB == nil {
		res.VRAMPeakMiB = []int{}
	}
	results := o.Results
	if results == nil {
		results = []schema.CaseResult{}
	}
	return schema.BenchSubmission{
		Schema:            schema.BenchV1,
		Client:            schema.Client{Name: "tenkstack", Version: version},
		Suite:             schema.SuiteRef{ID: s.ID, Version: s.Version},
		Hardware:          d.Hardware,
		Engine:            d.Engine,
		Model:             d.Model,
		Tuning:            d.Tuning,
		UnrecognizedFlags: unrecognized,
		Results:           results,
		Resources:         res,
		Run: schema.RunInfo{
			StartedAt:      started.UTC().Format(time.RFC3339),
			DurationS:      round(duration.Seconds(), 1),
			Tier:           tier,
			ColdStartS:     o.ColdStartS,
			ExternalPaused: true,
			Clean:          clean,
		},
	}
}

// Export is a saved submission as it may leave the machine: no
// paths, and flags by name only. The submission is built without them; this
// is the second line, for whatever a describer let through.
func Export(sub schema.BenchSubmission) schema.BenchSubmission {
	sub.Model = scrubModel(sub.Model)
	if sp := sub.Tuning.Speculative; sp != nil && sp.DraftModel != nil {
		copied := *sp
		draft := scrubModel(*sp.DraftModel)
		copied.DraftModel = &draft
		sub.Tuning.Speculative = &copied
	}
	if local(sub.Engine.Image) {
		sub.Engine.Image = ""
	}
	flags := make([]string, 0, len(sub.UnrecognizedFlags))
	for _, f := range sub.UnrecognizedFlags {
		name, _, _ := strings.Cut(f, "=")
		name = strings.TrimSpace(name)
		if name != "" && !local(name) {
			flags = append(flags, name)
		}
	}
	sub.UnrecognizedFlags = flags
	return sub
}

// local says whether a string names a place on this machine.
func local(s string) bool {
	return strings.HasPrefix(s, "/") || strings.HasPrefix(s, "~") || strings.HasPrefix(s, ".") ||
		strings.Contains(s, "${") || strings.Contains(s, "/home/") || strings.Contains(s, `:\`)
}

// scrubModel keeps a model's repo, file name, hash and quant. A repo or
// file that is really a path keeps its last element only.
func scrubModel(m schema.ModelRef) schema.ModelRef {
	if local(m.Repo) {
		m.Repo = ""
	}
	if local(m.File) {
		m.File = path.Base(strings.ReplaceAll(m.File, `\`, "/"))
	}
	return m
}
