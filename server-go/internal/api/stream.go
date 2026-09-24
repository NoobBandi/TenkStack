package api

// JournalLine is one log line from any source, classified.
type JournalLine struct {
	T     float64 `json:"t"`
	Unit  string  `json:"unit"`
	Label string  `json:"label"`
	Level string  `json:"level"` // info, warn, error
	Text  string  `json:"text"`
	// Key/value pairs behind an expander; nil for a line without structure.
	Fields [][2]string `json:"fields"`
	// Noise marks the console's own polling of llama-swap and Caddy: a
	// loopback GET every few seconds that the page hides by default.
	Noise bool `json:"noise,omitempty"`
	// Raw is the line as the program wrote it, only when that was a JSON
	// object: Text and Fields are the console's reading of it, with the
	// types flattened away, and a copy should be able to give back the
	// original.
	Raw string `json:"raw,omitempty"`
}

// LogsQuery is a window of history: the newest lines that matched, with
// counts over everything that matched so the page can say how much it is
// not showing.
type LogsQuery struct {
	Lines     []JournalLine `json:"lines"`
	Total     int           `json:"total"`
	Truncated bool          `json:"truncated"`
	Scanned   int           `json:"scanned"`
	// ScanCap means the window was too big to read to the end; Reached is
	// how far back the read got before stopping, since it runs newest first.
	ScanCap bool           `json:"scan_cap"`
	Reached *float64       `json:"reached"`
	ByLevel map[string]int `json:"by_level"`
	ByUnit  map[string]int `json:"by_unit"`
	Since   float64        `json:"since"`
	Until   float64        `json:"until"`
}

// LogSource is one place lines come from and whether anybody is reading it.
type LogSource struct {
	Unit  string `json:"unit"`
	Label string `json:"label"`
	Kind  string `json:"kind"` // unit or container
	// Present is whether the unit or container exists on this machine.
	Present bool `json:"present"`
	// State is systemd's ActiveState or docker's State, as they say it.
	State     string   `json:"state"`
	Following bool     `json:"following"`
	Buffered  int      `json:"buffered"`
	LastT     *float64 `json:"last_t"`
}

type JournalRetention struct {
	Available  bool     `json:"available"`
	Persistent bool     `json:"persistent"`
	DiskUsage  string   `json:"disk_usage"`
	Oldest     *float64 `json:"oldest"`
	Newest     *float64 `json:"newest"`
}

type LogSources struct {
	Sources []LogSource      `json:"sources"`
	Journal JournalRetention `json:"journal"`
}

type LogsPage struct {
	Lines []JournalLine     `json:"lines"`
	Units map[string]string `json:"units"`
}

// Event is one frame on the merged stream.
type Event struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

type Throughput struct {
	EvalMs          float64 `json:"eval_ms"`
	Tokens          int     `json:"tokens"`
	TokensPerSecond float64 `json:"tokens_per_second"`
}

// ProgressTick is one tick of a request's lifecycle; slot and task together
// identify the request.
type ProgressTick struct {
	Slot      int      `json:"slot"`
	Task      int      `json:"task"`
	Phase     string   `json:"phase"` // prefill, decode, done
	Tokens    int      `json:"tokens"`
	Rate      *float64 `json:"rate,omitempty"`
	Average   *float64 `json:"average,omitempty"`
	Progress  *float64 `json:"progress,omitempty"`
	Elapsed   *float64 `json:"elapsed,omitempty"`
	Truncated *bool    `json:"truncated,omitempty"`
}

type Slot struct {
	ID   any  `json:"id"`
	NCtx int  `json:"n_ctx"`
	Used int  `json:"used"`
	Busy bool `json:"busy"`
}

type ActivityRow struct {
	Ts              any     `json:"ts"`
	Model           *string `json:"model"`
	Input           int64   `json:"input"`
	Output          int64   `json:"output"`
	Depth           int64   `json:"depth"`
	PromptPerSecond float64 `json:"prompt_per_second"`
	TokensPerSecond float64 `json:"tokens_per_second"`
	DurationMs      int64   `json:"duration_ms"`
	Status          *int64  `json:"status"`
	// Estimated means the server reported no rate and this one is the
	// output over the whole request, prefill included.
	Estimated bool `json:"estimated,omitempty"`
}

type LastUsed struct {
	Model *string `json:"model"`
}

type ContainerSample struct {
	Name        string   `json:"name"`
	T           float64  `json:"t"`
	Memory      int64    `json:"memory"`
	MemoryLimit *int64   `json:"memory_limit"`
	CPUPercent  *float64 `json:"cpu_percent"`
	NetRx       *float64 `json:"net_rx"`
	NetTx       *float64 `json:"net_tx"`
}

type ContainerPoint struct {
	T      float64  `json:"t"`
	Memory int64    `json:"memory"`
	CPU    *float64 `json:"cpu"`
	Rx     *float64 `json:"rx"`
	Tx     *float64 `json:"tx"`
}

type ContainerHistory struct {
	Interval float64                     `json:"interval"`
	Series   map[string][]ContainerPoint `json:"series"`
}
