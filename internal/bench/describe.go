// Package bench runs the benchmark suite (跑分) against one llama-swap model
// and keeps the results.
package bench

import (
	"context"

	"github.com/NoobBandi/TenkStack/internal/schema"
)

// Description is everything a run reports about what it measured, apart from
// the measurements: the machine, the model's files, the engine and the
// parameters it was launched with.
type Description struct {
	ModelID string // the llama-swap id
	Name    string // its display name
	Command string // the launch command as written, kept locally, never exported

	Hardware     schema.HardwareProfile
	Model        schema.ModelRef
	Engine       schema.EngineRef // Engine.Key decides whether ignore_eos is sent
	Tuning       schema.Tuning    // Tuning.ContextLength decides which depths run; 0 = unknown
	Unrecognized []string         // flag names Tuning could not place, values left out
	// ServedContext is the tokens one request may use as the running
	// engine reports it, 0 when the model is not running or does not say.
	// It decides which depths run ahead of Tuning: the engine knows its
	// limit where a wrapper script's command does not name one.
	ServedContext int
}

// ContextLimit is how many tokens one request may use, 0 when unknown: what
// the engine reports, else what the launch command says.
func (d Description) ContextLimit() int {
	if d.ServedContext > 0 {
		return d.ServedContext
	}
	return contextLimit(d.Tuning)
}

// Describer describes a llama-swap model as it is configured now. The
// console wires one that reads the GPU registry, the system, llama-swap's
// config and the engine registry; tests pass their own.
type Describer interface {
	Describe(ctx context.Context, modelID string) (Description, error)
}
