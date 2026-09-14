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
