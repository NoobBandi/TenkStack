// Package activity reads per-request history out of llama-swap's own store,
// opened read-only and per call: it is another process's database.
package activity

import (
	"database/sql"
	"fmt"
	"os"

	_ "modernc.org/sqlite"

	"github.com/NoobBandi/TenkStack/internal/api"
)

// Below this a row says nothing about sustained speed.
const minOutputTokens = 20

type Store struct {
	path string
}

func New(path string) *Store { return &Store{path: path} }

func (s *Store) open() (*sql.DB, error) {
	if _, err := os.Stat(s.path); err != nil {
		return nil, err
	}
	return sql.Open("sqlite", fmt.Sprintf("file:%s?mode=ro&_pragma=busy_timeout(2000)", s.path))
}

// Recent lists completed requests, newest first, that carry a usable rate.
// A missing table or a locked file is the normal state and yields nothing.
func (s *Store) Recent(limit int, modelID string) []api.ActivityRow {
	out := []api.ActivityRow{}
	db, err := s.open()
	if err != nil {
		return out
	}
	defer db.Close()
	// A row without a rate is kept when it has a duration: vLLM streams
	// report usage and no timings, so llama-swap records its tokens and
	// -1 for both speeds, and dropping those rows dropped every vLLM request
	// from the overview.
	query := `SELECT ts_created, model_id, input_tokens, output_tokens, cache_tokens,
	                 prompt_per_second, tokens_per_second, duration_ms, resp_status_code
	          FROM activity WHERE output_tokens >= ? AND (tokens_per_second > 0 OR duration_ms > 0)`
	args := []any{minOutputTokens}
	if modelID != "" {
		query += " AND model_id = ?"
		args = append(args, modelID)
	}
	query += " ORDER BY id DESC LIMIT ?"
	args = append(args, limit)
	rows, err := db.Query(query, args...)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var (
			r                         api.ActivityRow
			input, output, depth, dur sql.NullInt64
			pps, tps                  sql.NullFloat64
		)
		if err := rows.Scan(&r.Ts, &r.Model, &input, &output, &depth, &pps, &tps, &dur, &r.Status); err != nil {
			continue
		}
		r.Input, r.Output, r.Depth, r.DurationMs = input.Int64, output.Int64, depth.Int64, dur.Int64
		r.PromptPerSecond, r.TokensPerSecond = pps.Float64, tps.Float64
		if r.TokensPerSecond <= 0 {
			// The whole request's average, prefill included: an
			// underestimate of the decode rate, and marked as one.
			r.TokensPerSecond = float64(r.Output) / (float64(r.DurationMs) / 1000)
			r.PromptPerSecond = 0
			r.Estimated = true
		}
		if r.Depth < 0 {
			// -1 is llama-swap's "not reported"; the prompt is the depth
			// the reply started at.
			r.Depth = r.Input
		}
		out = append(out, r)
	}
	return out
}

// LastUsed is the model of the most recent request, for pages that must
// name one on a cold box.
func (s *Store) LastUsed() *string {
	db, err := s.open()
	if err != nil {
		return nil
	}
	defer db.Close()
	var model string
	err = db.QueryRow("SELECT model_id FROM activity WHERE model_id IS NOT NULL AND model_id != '' ORDER BY id DESC LIMIT 1").Scan(&model)
	if err != nil {
		return nil
	}
	return &model
}
