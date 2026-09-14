package api

// ModelSpec is what the editor sends and what it is handed back.
type ModelSpec struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description string  `json:"description"`
	ModelFile   string  `json:"model_file"`
	CtxSize     int     `json:"ctx_size"`
	NGpuLayers  int     `json:"n_gpu_layers"`
	TTL         int     `json:"ttl"`
	Group       *string `json:"group"`
	Extra       string  `json:"extra"`
	Mmproj      *string `json:"mmproj"`
	// Only the fields that were set; absent means llama.cpp's own default.
	Sampling map[string]float64 `json:"sampling"`
	// Which cards to run on, as backend:index, one or several. Absent
	// leaves the entry's card alone; empty clears it; a value pins.
	Device any `json:"device"`
}

// ModelSpecOut is a configured entry parsed back into the editor's fields.
type ModelSpecOut struct {
	ID          string            `json:"id"`
	Env         map[string]string `json:"env"`
	Wrapper     string            `json:"wrapper"`
	Name        string            `json:"name"`
	Description string            `json:"description"`
	ModelFile   string            `json:"model_file"`
	Mmproj      *string           `json:"mmproj"`
	CtxSize     int               `json:"ctx_size"`
	NGpuLayers  int               `json:"n_gpu_layers"`
	TTL         int               `json:"ttl"`
	Group       *string           `json:"group"`
	Sampling    map[string]any    `json:"sampling"`
	Extra       string            `json:"extra"`
}

type ModelFile struct {
	Filename   string   `json:"filename"`
	Exists     bool     `json:"exists"`
	SizeBytes  int64    `json:"size_bytes"`
	SharedWith []string `json:"shared_with"`
}

type Weight struct {
	Filename   string   `json:"filename"`
	Basename   string   `json:"basename"`
	Repo       string   `json:"repo"`
	Role       string   `json:"role"` // model or mmproj
	Exists     bool     `json:"exists"`
	SizeBytes  int64    `json:"size_bytes"`
	SharedWith []string `json:"shared_with"`
}

type GGUFFile struct {
	Filename  string   `json:"filename"`
	Repo      string   `json:"repo"`
	SizeBytes int64    `json:"size_bytes"`
	SizeGiB   float64  `json:"size_gib"`
	Modified  float64  `json:"modified"`
	IsMmproj  bool     `json:"is_mmproj"`
	Role      string   `json:"role"`
	UsedBy    []string `json:"used_by"`
}

type Partial struct {
	Filename  string  `json:"filename"`
	SizeBytes int64   `json:"size_bytes"`
	SizeGiB   float64 `json:"size_gib"`
}

type DeletedFile struct {
	Filename  string `json:"filename"`
	SizeBytes int64  `json:"size_bytes"`
}

type KeptFile struct {
	Filename string `json:"filename"`
	Reason   string `json:"reason"`
}

type ModelDeleted struct {
	OK      bool          `json:"ok"`
	Deleted []DeletedFile `json:"deleted"`
	Kept    []KeptFile    `json:"kept"`
}

type FileDeleted struct {
	OK        bool   `json:"ok"`
	Filename  string `json:"filename"`
	SizeBytes int64  `json:"size_bytes"`
}

type ModelWritten struct {
	OK bool   `json:"ok"`
	ID string `json:"id"`
}

type Recommended struct {
	Sampling map[string]any `json:"sampling"`
}

type Capabilities struct {
	Vision bool   `json:"vision"`
	Audio  bool   `json:"audio"`
	Tools  bool   `json:"tools"`
	Source string `json:"source"` // live or config
}
