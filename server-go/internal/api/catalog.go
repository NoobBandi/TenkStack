package api

type CatalogRepo struct {
	RepoID       any   `json:"repo_id"`
	Downloads    any   `json:"downloads"`
	Likes        any   `json:"likes"`
	LastModified any   `json:"last_modified"`
	Tags         []any `json:"tags"`
}

// CatalogFile is one model, not one file: a split model's parts are one
// entry, named by its first part.
type CatalogFile struct {
	Filename  string   `json:"filename"`
	Parts     []string `json:"parts"`
	PartCount int      `json:"part_count"`
	SizeBytes int64    `json:"size_bytes"`
	SizeGiB   float64  `json:"size_gib"`
	IsMmproj  bool     `json:"is_mmproj"`
	OnDisk    bool     `json:"on_disk"`
	LocalPath string   `json:"local_path"`
	Elsewhere []string `json:"elsewhere"`
}

type Download struct {
	RepoID          string  `json:"repo_id"`
	Filename        string  `json:"filename"`
	TotalBytes      int64   `json:"total_bytes"`
	DownloadedBytes int64   `json:"downloaded_bytes"`
	Percent         float64 `json:"percent"`
	State           string  `json:"state"` // queued, downloading, done, error, cancelled
	Error           *string `json:"error"`
	MiBPerSecond    float64 `json:"mib_per_second"`
}
