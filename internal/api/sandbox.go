package api

// SandboxStatus is whether the agent's Python runs on this machine, in a
// container under gVisor, or falls back to the browser.
type SandboxStatus struct {
	// Runtime is gVisor (runsc) registered with Docker. Without it nothing
	// runs here: the plain runtime is not an isolation boundary for code a
	// model wrote.
	Runtime bool `json:"runtime"`
	// State of the image: absent, building, ready, outdated (an older
	// build is here and still serves runs), error.
	State   string `json:"state"`
	Ready   bool   `json:"ready"`
	Image   string `json:"image,omitempty"`
	Message string `json:"message,omitempty"`
	// Sessions is the containers alive now, one per conversation.
	Sessions  int   `json:"sessions"`
	TimeoutS  int64 `json:"timeout_s"`
	MemoryGiB int64 `json:"memory_gib"`
	IdleMin   int   `json:"idle_min"`
}

// SandboxFile is a file a call wrote or changed in the working directory.
type SandboxFile struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

// SandboxRun is one call's result, in the shape the browser's Python
// returns so the chat handles both the same way.
type SandboxRun struct {
	Stdout    string        `json:"stdout"`
	Stderr    string        `json:"stderr"`
	Value     *string       `json:"value"`
	Error     *string       `json:"error"`
	Images    []string      `json:"images"`
	Files     []SandboxFile `json:"files"`
	ElapsedMS int64         `json:"elapsed_ms"`
	TimedOut  bool          `json:"timed_out"`
	Truncated bool          `json:"truncated"`
	// Interrupted is a call stopped at the time limit with its namespace
	// kept; Reset is an environment that had to be started again, so what
	// earlier calls defined is gone.
	Interrupted bool `json:"interrupted"`
	Reset       bool `json:"reset"`
}
