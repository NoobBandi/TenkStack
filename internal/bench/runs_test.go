package bench

import (
	"context"
	"testing"
	"time"

	"github.com/NoobBandi/TenkStack/internal/api"
	"github.com/NoobBandi/TenkStack/internal/schema"
	"github.com/NoobBandi/TenkStack/internal/store/storetest"
)

func TestRuns(t *testing.T) {
	ctx := context.Background()
	runs := NewRuns(storetest.New(t))
	d := describe("vllm", 65536)
	cold := 120.0
	first := Assemble(SuiteV1(), d, "t", api.BenchQuick,
		Outcome{Results: []schema.CaseResult{{CaseID: "conc-4", GenTPS: 20}, {CaseID: "depth-1k", GenTPS: 45.5, TTFTMs: 300}}, ColdStartS: &cold},
		schema.Resources{VRAMPeakMiB: []int{30000}, RAMPeakMiB: 16000}, time.Unix(1000, 0), 200*time.Second, true)
	id1, err := runs.Save(ctx, d, first, time.Unix(1000, 0))
	if err != nil {
		t.Fatal(err)
	}
	d.Tuning.ContextLength = 32768
	second := Assemble(SuiteV1(), d, "t", api.BenchQuick, Outcome{}, schema.Resources{}, time.Unix(2000, 0), 90*time.Second, true)
	id2, err := runs.Save(ctx, d, second, time.Unix(2000, 0))
	if err != nil {
		t.Fatal(err)
	}

	rows, err := runs.List(ctx)
	if err != nil || len(rows) != 2 || rows[0].ID != id2 || rows[1].ID != id1 {
		t.Fatalf("newest first: %+v %v", rows, err)
	}
	old := rows[1]
	if old.GenTPS1k == nil || *old.GenTPS1k != 45.5 || *old.TTFTMs1k != 300 || old.Engine != "vllm" || old.Tier != "quick" ||
		old.StartedAt != 1000 || old.DurationS != 200 || old.Name != "M" || old.Model != "m" {
		t.Errorf("row: %+v", old)
	}
	if rows[0].GenTPS1k != nil || rows[0].TuningHash == old.TuningHash || old.TuningHash != TuningHash(first.Tuning) {
		t.Errorf("hash and headline: %+v vs %+v", rows[0], old)
	}

	full, err := runs.Get(ctx, id1)
	if err != nil || full == nil || full.Command != d.Command || full.Submission.Resources.RAMPeakMiB != 16000 ||
		full.Submission.Run.ColdStartS == nil || len(full.Submission.Results) != 2 {
		t.Fatalf("get: %+v %v", full, err)
	}
	if missing, err := runs.Get(ctx, 9999); missing != nil || err != nil {
		t.Errorf("missing run: %v %v", missing, err)
	}

	// The last run of the model and tier, cold start taken out.
	runs.Delete(ctx, id2)
	if d, ok := runs.LastDuration(ctx, "m", api.BenchQuick); !ok || d != 80 {
		t.Errorf("last duration %v %v", d, ok)
	}
	if _, ok := runs.LastDuration(ctx, "m", api.BenchFull); ok {
		t.Error("no full run yet")
	}
	if found, _ := runs.Delete(ctx, id2); found {
		t.Error("deleted twice")
	}
}
