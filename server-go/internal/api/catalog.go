package api

type CatalogRepo struct {
	RepoID       any   `json:"repo_id"`
	Downloads    any   `json:"downloads"`
	Likes        any   `json:"likes"`
	LastModified any   `json:"last_modified"`
	Tags         []any `json:"tags"`
	// Gated: the Hub opens its files only to an accepted, signed-in user.
	Gated bool `json:"gated"`
	// Format is how the catalog offers it: gguf, a choice of files, or
	// safetensors, a folder.
	Format string `json:"format"`
	// Vision: it takes images, as far as the Hub's task and tags say.
	Vision bool `json:"vision"`
}

// CatalogVariant is the same model in another precision.
type CatalogVariant struct {
	RepoID string `json:"repo_id"`
	// Precision is read from the Hub's tags and tensor counts, before the
	// config is: bf16, fp8, int4, awq, gptq, nvfp4, …
	Precision string  `json:"precision"`
	SizeGiB   float64 `json:"size_gib"`
	Downloads int64   `json:"downloads"`
	Gated     bool    `json:"gated"`
	// Base: the repository the others were quantised from.
	Base bool `json:"base"`
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
	// LocalPath is where it is, when OnDisk, else where it would land in
	// the default location, as a model entry names it.
	LocalPath string   `json:"local_path"`
	Elsewhere []string `json:"elsewhere"`
}

type Download struct {
	RepoID   string `json:"repo_id"`
	Filename string `json:"filename"`
	// Location is the model location it is written to, and LocalPath the
	// result as a model entry names it.
	Location        string  `json:"location"`
	LocalPath       string  `json:"local_path"`
	TotalBytes      int64   `json:"total_bytes"`
	DownloadedBytes int64   `json:"downloaded_bytes"`
	Percent         float64 `json:"percent"`
	State           string  `json:"state"` // queued, downloading, verifying, done, error, cancelled
	Error           *string `json:"error"`
	MiBPerSecond    float64 `json:"mib_per_second"`
	// Kind is file for a GGUF, folder for a repository a server engine
	// loads whole; a folder's Filename is empty.
	Kind      string `json:"kind"`
	Files     int    `json:"files"`
	FilesDone int    `json:"files_done"`
	Current   string `json:"current"`
}

// CatalogFolder is a repository as a server engine loads it.
type CatalogFolder struct {
	RepoID    string              `json:"repo_id"`
	Files     []CatalogFolderFile `json:"files"`
	SizeBytes int64               `json:"size_bytes"`
	SizeGiB   float64             `json:"size_gib"`
	// Loadable: it has safetensors weights and a config.json.
	Loadable      bool   `json:"loadable"`
	Architecture  string `json:"architecture"`
	Precision     string `json:"precision"`
	Quantized     bool   `json:"quantized"`
	Vision        bool   `json:"vision"`
	MTP           bool   `json:"mtp"`
	ContextLength int    `json:"context_length"`
	// KVBytesPerToken is a token of context in a 16-bit attention cache,
	// 0 when the config does not say; Hybrid: only some layers keep one.
	KVBytesPerToken int64 `json:"kv_bytes_per_token"`
	Hybrid          bool  `json:"hybrid"`
	// Experts is a mixture of experts' count and how many each token uses;
	// 0 for a dense model.
	Experts       int `json:"experts"`
	ExpertsActive int `json:"experts_active"`
	// Gated, and NeedsAccess when the Hub would not open it: what to do.
	Gated       bool   `json:"gated"`
	NeedsAccess string `json:"needs_access"`
	// OnDisk: all of it is in Location. Otherwise Location is where a
	// download would put it and PresentBytes how much of it is there.
	OnDisk       bool   `json:"on_disk"`
	PresentBytes int64  `json:"present_bytes"`
	Location     string `json:"location"`
	LocalPath    string `json:"local_path"`
}

type CatalogFolderFile struct {
	Name      string `json:"name"`
	SizeBytes int64  `json:"size_bytes"`
}

// HuggingFace is the owner's Hugging Face token as the settings page shows
// it: whether one is set, its last characters, and whose it is.
type HuggingFace struct {
	Set  bool   `json:"set"`
	Hint string `json:"hint"`
	User string `json:"user"`
}
