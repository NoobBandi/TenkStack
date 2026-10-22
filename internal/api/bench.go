package api

import "github.com/NoobBandi/TenkStack/internal/schema"

// The benchmark (跑分), phase one of the parameter workshop: a suite run
// against one llama-swap model on this machine, with outside requests on
// /v1 paused for its duration. Endpoints:
//
//	GET    /api/bench/plan?model=ID&tier=quick|full|custom[&cases=a,b&repeats=1]  BenchPlan  admin
//	POST   /api/bench/run         BenchRunRequest -> BenchProgress (202)  admin
//	GET    /api/bench/status      BenchProgress                           any signed-in user (the banner)
//	POST   /api/bench/cancel      BenchProgress                           admin
//	GET    /api/bench/runs        []BenchRunRow, newest first             admin
//	GET    /api/bench/runs/{id}   BenchRun                                admin
//	GET    /api/bench/runs/{id}/export  schema.BenchSubmission, as a download, local details removed  admin
//	DELETE /api/bench/runs/{id}  -> 204                                   admin
//
// While a run is in BenchDraining or BenchRunning, /v1 answers 503 with
// Retry-After and BenchPausedMessage.

const (
	BenchQuick = "quick"
	BenchFull  = "full"
	// BenchCustom is the cases a person picked, rather than a tier's.
	BenchCustom = "custom"
)

// Bench states. Draining: outside requests are refused and the run waits
// for those already in flight to finish.
const (
	BenchIdle      = "idle"
	BenchDraining  = "draining"
	BenchRunning   = "running"
	BenchDone      = "done"
	BenchFailed    = "failed"
	BenchCancelled = "cancelled"
)

type BenchRunRequest struct {
	Model string `json:"model"` // a llama-swap model id
	Tier  string `json:"tier"`  // BenchQuick | BenchFull | BenchCustom
	// Cases and Repeats are BenchCustom's: the case ids picked (the
	// one-person 1k is always measured, every comparison is against it),
	// and 1 to measure each once or 0 as often as the full tier does.
	Cases   []string `json:"cases,omitempty"`
	Repeats int      `json:"repeats,omitempty"`
	// Force starts without waiting for requests still in flight. Sent
	// again for the model and tier already draining, it ends that drain
	// and starts the run (202, not 409). Without it a drain past its limit
	// sets DrainTimedOut and keeps waiting, cancelling itself only after a
	// further grace. It also starts while ComfyUI is busy, otherwise a 409.
	Force bool `json:"force,omitempty"`
}

// BenchPlan is what the confirmation shows before a run starts.
type BenchPlan struct {
	Model   string   `json:"model"`
	Name    string   `json:"name"` // the entry's display name
	Engine  string   `json:"engine"`
	Tier    string   `json:"tier"`
	Cases   []string `json:"cases"`   // case ids that will run (deeper than the context are left out)
	Skipped []string `json:"skipped"` // case ids left out, and why, as "id: reason"
	Unloads []string `json:"unloads"` // models llama-swap will unload to load this one
	Loaded  bool     `json:"loaded"`  // already running: no cold start
	// Context is the tokens one request may use, which decides the depths
	// that run; 0 unknown. ContextServed: the running engine reported it,
	// rather than it being read off the launch command.
	Context       int  `json:"context"`
	ContextServed bool `json:"context_served"`
	EstimatedS    int  `json:"estimated_s"` // rough, for the confirmation and the pause message
	InFlight      int  `json:"in_flight"`   // outside requests running now
	ComfyBusy     bool `json:"comfy_busy"`  // a ComfyUI job is queued or running on these cards
}

type BenchProgress struct {
	State string `json:"state"`
	RunID *int64 `json:"run_id,omitempty"` // set once the run is saved
	Model string `json:"model,omitempty"`
	Tier  string `json:"tier,omitempty"`
	// Cases and Repeats are a custom run's, as it was asked for, so the
	// page can send the same request again to force its start.
	Cases     []string `json:"cases,omitempty"`
	Repeats   int      `json:"repeats,omitempty"`
	StartedAt int64    `json:"started_at,omitempty"`
	Case      string   `json:"case,omitempty"` // the case running now
	Done      int      `json:"done"`           // cases finished
	Total     int      `json:"total"`
	InFlight  int      `json:"in_flight"`           // while draining
	ResumeAt  int64    `json:"resume_at,omitempty"` // when /v1 is expected back (unix seconds)
	Message   string   `json:"message,omitempty"`   // what it is doing, in Chinese, for the UI
	Error     string   `json:"error,omitempty"`     // failed
	ElapsedS  float64  `json:"elapsed_s,omitempty"`
	// Results so far, so the drawer can fill its table while it runs.
	Results []schema.CaseResult `json:"results"`
	// Skipped is the cases left out so far, as "id: reason": deeper than
	// the context, or no valid sample (an error, or output too short).
	Skipped []string `json:"skipped,omitempty"`
	// DrainTimedOut: the drain has waited past its limit with outside
	// requests still running; the UI offers to force the start.
	DrainTimedOut bool `json:"drain_timed_out,omitempty"`
}

// BenchRunRow is one saved run in the list.
type BenchRunRow struct {
	ID         int64    `json:"id"`
	Model      string   `json:"model"` // llama-swap id at the time
	Name       string   `json:"name"`
	Engine     string   `json:"engine"`
	Tier       string   `json:"tier"`
	StartedAt  int64    `json:"started_at"`
	DurationS  float64  `json:"duration_s"`
	GenTPS1k   *float64 `json:"gen_tps_1k"` // single stream at 1k depth, the headline number
	TTFTMs1k   *float64 `json:"ttft_ms_1k"`
	TuningHash string   `json:"tuning_hash"` // equal hashes: the same parameters
}

// BenchRun is a saved run in full. Command is the launch command as it was,
// local only: it never leaves the machine (the export drops it).
type BenchRun struct {
	BenchRunRow
	Command    string                 `json:"command"`
	Submission schema.BenchSubmission `json:"submission"`
}

// BenchPausedMessage is the 503 body's detail while a run holds /v1.
const BenchPausedMessage = "主控台正在跑分，暫停對外服務，預計 %s 恢復"
