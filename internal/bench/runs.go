package bench

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/NoobBandi/TenkStack/internal/api"
	"github.com/NoobBandi/TenkStack/internal/schema"
	"github.com/NoobBandi/TenkStack/internal/store"
)

// TuningHash names a set of parameters: equal hashes, the same parameters,
// which is how the run list says two runs differ only in the model or the
// machine. A variable so the console can put tuning's own hash in its place.
var TuningHash = func(t schema.Tuning) string {
	// Go marshals struct fields in declaration order, and Tuning has no
	// maps, so this is canonical as long as the schema is.
	b, _ := json.Marshal(t)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// Runs keeps finished runs in the console's database (D30).
type Runs struct{ db *sql.DB }

func NewRuns(db *sql.DB) *Runs { return &Runs{db: db} }

// Save keeps one run and returns its id.
func (r *Runs) Save(ctx context.Context, d Description, sub schema.BenchSubmission, started time.Time) (int64, error) {
	raw, err := json.Marshal(sub)
	if err != nil {
		return 0, err
	}
	var id int64
	err = r.db.QueryRowContext(ctx, `INSERT INTO bench_runs
		(model, name, engine, tier, started_at, duration_s, tuning_hash, command, submission, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10) RETURNING id`,
		store.Text(d.ModelID), store.Text(d.Name), sub.Engine.Key, sub.Run.Tier, started.Unix(), sub.Run.DurationS,
		TuningHash(sub.Tuning), store.Text(d.Command), store.Text(string(raw)), time.Now().Unix()).Scan(&id)
	return id, err
}

const runColumns = `id, model, name, engine, tier, started_at, duration_s, tuning_hash, submission`

func scanRow(scan func(...any) error) (api.BenchRunRow, schema.BenchSubmission, error) {
	var row api.BenchRunRow
	var raw []byte
	var sub schema.BenchSubmission
	if err := scan(&row.ID, &row.Model, &row.Name, &row.Engine, &row.Tier, &row.StartedAt, &row.DurationS,
		&row.TuningHash, &raw); err != nil {
		return row, sub, err
	}
	if err := json.Unmarshal(raw, &sub); err != nil {
		return row, sub, err
	}
	row.GenTPS1k, row.TTFTMs1k = headline(sub.Results)
	return row, sub, nil
}

// headline is the single stream at 1k: depth-1k, or the same condition
// under another name when a run left it out.
func headline(results []schema.CaseResult) (gen, ttft *float64) {
	for _, id := range []string{"depth-1k", "conc-1", "content-en"} {
		for _, r := range results {
			if r.CaseID == id {
				g, t := r.GenTPS, r.TTFTMs
				return &g, &t
			}
		}
	}
	return nil, nil
}

// List is every run, newest first.
func (r *Runs) List(ctx context.Context) ([]api.BenchRunRow, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT `+runColumns+` FROM bench_runs ORDER BY started_at DESC, id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []api.BenchRunRow{}
	for rows.Next() {
		row, _, err := scanRow(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// Get is one run in full; nil when there is no such run.
func (r *Runs) Get(ctx context.Context, id int64) (*api.BenchRun, error) {
	var command string
	row, sub, err := scanRow(func(dest ...any) error {
		return r.db.QueryRowContext(ctx, `SELECT `+runColumns+`, command FROM bench_runs WHERE id = $1`, id).
			Scan(append(dest, &command)...)
	})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &api.BenchRun{BenchRunRow: row, Command: command, Submission: sub}, nil
}

// Delete removes one run; false when there was none.
func (r *Runs) Delete(ctx context.Context, id int64) (bool, error) {
	res, err := r.db.ExecContext(ctx, `DELETE FROM bench_runs WHERE id = $1`, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// LastDuration is how long the newest run of this model and tier took,
// without its cold start: a better estimate than any formula.
func (r *Runs) LastDuration(ctx context.Context, model, tier string) (float64, bool) {
	var d float64
	var cold sql.NullFloat64
	err := r.db.QueryRowContext(ctx, `SELECT duration_s, (submission->'run'->>'cold_start_s')::double precision
		FROM bench_runs WHERE model = $1 AND tier = $2 ORDER BY started_at DESC, id DESC LIMIT 1`, model, tier).Scan(&d, &cold)
	if err != nil {
		return 0, false
	}
	if cold.Valid {
		d -= cold.Float64
	}
	return d, d > 0
}
