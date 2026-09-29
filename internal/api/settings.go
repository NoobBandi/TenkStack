package api

// Setting is one of the console's knobs with its spec, for the page to
// render and validate.
type Setting struct {
	Name    string `json:"name"`
	Value   int64  `json:"value"`
	Label   string `json:"label"`
	Note    string `json:"note"`
	Default int64  `json:"default"`
	Minimum int64  `json:"minimum"`
	Maximum int64  `json:"maximum"`
	Unit    string `json:"unit"`
	Group   string `json:"group"`
}

type SystemCPU struct {
	Percent *float64  `json:"percent"`
	Cores   int       `json:"cores"`
	Model   *string   `json:"model"`
	Load    []float64 `json:"load"`
}

type SystemMemory struct {
	TotalBytes     int64   `json:"total_bytes"`
	AvailableBytes int64   `json:"available_bytes"`
	UsedBytes      int64   `json:"used_bytes"`
	Percent        float64 `json:"percent"`
}

type SystemSwap struct {
	TotalBytes int64   `json:"total_bytes"`
	UsedBytes  int64   `json:"used_bytes"`
	Percent    float64 `json:"percent"`
}

type SystemDisk struct {
	Path          string  `json:"path"`
	TotalBytes    int64   `json:"total_bytes"`
	UsedBytes     int64   `json:"used_bytes"`
	FreeBytes     int64   `json:"free_bytes"`
	ReservedBytes int64   `json:"reserved_bytes"`
	Percent       float64 `json:"percent"`
}

type SystemSample struct {
	CPU           SystemCPU    `json:"cpu"`
	Memory        SystemMemory `json:"memory"`
	Swap          SystemSwap   `json:"swap"`
	Disks         []SystemDisk `json:"disks"`
	UptimeSeconds *float64     `json:"uptime_seconds"`
}

// Release is the newest TenkStack on GitHub against this installation.
type Release struct {
	Current string `json:"current"`
	Repo    string `json:"repo"`
	Arch    string `json:"arch"`
	// Latest is the tag without its v; nil when the ask failed, with why
	// in Error.
	Latest      *string        `json:"latest"`
	Newer       bool           `json:"newer"`
	Name        string         `json:"name"`
	Body        string         `json:"body"`
	URL         string         `json:"url"`
	PublishedAt *float64       `json:"published_at"`
	Assets      []ReleaseAsset `json:"assets"`
	CheckedAt   *float64       `json:"checked_at"`
	Error       string         `json:"error,omitempty"`
	// CanApply is whether this process could replace itself with the
	// release; ApplyNote says what is in the way, or what to do after.
	CanApply  bool   `json:"can_apply"`
	ApplyNote string `json:"apply_note,omitempty"`
}

type ReleaseAsset struct {
	Name string `json:"name"`
	URL  string `json:"url"`
	Size int64  `json:"size"`
}

type ReleaseApply struct {
	OK         bool   `json:"ok"`
	Version    string `json:"version"`
	Path       string `json:"path"`
	Restarting bool   `json:"restarting"`
	Unit       string `json:"unit,omitempty"`
	Detail     string `json:"detail,omitempty"`
}
