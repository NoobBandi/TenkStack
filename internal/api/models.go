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
	// Runtime is the launcher macro without its braces: llama-sycl,
	// vllm-intel. Empty keeps the entry's launcher, or the default.
	Runtime string `json:"runtime"`
	// vLLM only: online quantisation (fp8, sym_int4) and the share of the
	// card it pre-allocates.
	Quantization         string  `json:"quantization"`
	GpuMemoryUtilization float64 `json:"gpu_memory_utilization"`
}

// ModelSpecOut is a configured entry parsed back into the editor's fields.
type ModelSpecOut struct {
	ID      string            `json:"id"`
	Env     map[string]string `json:"env"`
	Wrapper string            `json:"wrapper"`
	// Runtime is the wrapper's macro name; Provider which software it is.
	Runtime  string `json:"runtime"`
	Provider string `json:"provider"`
	// Format of the weights the entry names: gguf or safetensors.
	Format               string         `json:"format"`
	Quantization         string         `json:"quantization"`
	GpuMemoryUtilization float64        `json:"gpu_memory_utilization"`
	Name                 string         `json:"name"`
	Description          string         `json:"description"`
	ModelFile            string         `json:"model_file"`
	Mmproj               *string        `json:"mmproj"`
	CtxSize              int            `json:"ctx_size"`
	NGpuLayers           int            `json:"n_gpu_layers"`
	TTL                  int            `json:"ttl"`
	Group                *string        `json:"group"`
	Sampling             map[string]any `json:"sampling"`
	Extra                string         `json:"extra"`
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
	// Parts is how many shards a split GGUF is, the first of which names
	// it; the size is theirs together. Omitted for one file.
	Parts int `json:"parts,omitempty"`
	// Location is the model location the file is in, by its key.
	Location string `json:"location"`
}

// GGUFFile is one set of weights on disk: a GGUF, or a directory of
// safetensors as Hugging Face publishes them, which the format says.
//
// Filename is how a model entry names it: relative to the primary model
// location, or ${models-dir-N}/… in another, which is also what the entry's
// cmd says. Repo is <owner>/<repo> within its location either way.
type GGUFFile struct {
	Filename string `json:"filename"`
	Location string `json:"location"`
	Format   string `json:"format"`
	// Precision of a safetensors model from its config.json: bf16, fp16,
	// fp8, awq, gptq, int4, mxfp4. Quantized says the publisher already
	// quantised it, so the runtime must not be asked to again.
	Precision string `json:"precision,omitempty"`
	Quantized bool   `json:"quantized,omitempty"`
	// Architecture is the first entry of config.json's architectures, which
	// is what decides a runtime's flags and whether the model sees images.
	Architecture string   `json:"architecture,omitempty"`
	Repo         string   `json:"repo"`
	SizeBytes    int64    `json:"size_bytes"`
	SizeGiB      float64  `json:"size_gib"`
	Modified     float64  `json:"modified"`
	IsMmproj     bool     `json:"is_mmproj"`
	Role         string   `json:"role"`
	UsedBy       []string `json:"used_by"`
}

type Partial struct {
	Filename  string  `json:"filename"`
	Location  string  `json:"location"`
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
	// Params is the chat panel's sampling controls the model's engine
	// takes, each under the name the engine wants it sent by.
	Params map[string]string `json:"params"`
}

// QuantTool is the quantisation image for one vendor and whether it is here.
type QuantTool struct {
	Vendor string `json:"vendor"`
	Base   string `json:"base"`
	Image  string `json:"image"`
	// absent, building, ready, error, no-base (vLLM not installed), unsupported
	State   string `json:"state"`
	Message string `json:"message"`
}

type QuantScheme struct {
	Key    string  `json:"key"`
	Label  string  `json:"label"`
	Family string  `json:"family"`
	Suffix string  `json:"suffix"`
	Shrink float64 `json:"shrink"`
	Tuned  bool    `json:"tuned"`
	Note   string  `json:"note"`
}

type QuantJob struct {
	ID          string   `json:"id"`
	Source      string   `json:"source"`
	Output      string   `json:"output"`
	Scheme      string   `json:"scheme"`
	Family      string   `json:"family"`
	Speed       string   `json:"speed"`
	Card        int      `json:"card"`
	State       string   `json:"state"` // running, done, error, cancelled
	BlocksDone  int      `json:"blocks_done"`
	BlocksTotal int      `json:"blocks_total"`
	Message     string   `json:"message"`
	Log         []string `json:"log"`
	SourceBytes int64    `json:"source_bytes"`
	StartedAt   int64    `json:"started_at"`
	FinishedAt  int64    `json:"finished_at"`
}

type QuantPage struct {
	Tools   []QuantTool   `json:"tools"`
	Schemes []QuantScheme `json:"schemes"`
	Speeds  []string      `json:"speeds"`
	Jobs    []QuantJob    `json:"jobs"`
}

// ModelLocation is one directory models are downloaded to and read from,
// at most five. Its key is the llama-swap macro model entries name it by:
// models-dir for the primary, which cannot be removed, and models-dir-2 to
// models-dir-5 for the rest.
type ModelLocation struct {
	Key     string `json:"key"`
	Path    string `json:"path"`
	Label   string `json:"label"`
	Primary bool   `json:"primary"`
	// DefaultFor is the formats new downloads of which land here: gguf for
	// llama.cpp, safetensors for vLLM. Each format has exactly one.
	DefaultFor []string `json:"default_for"`
	Exists     bool     `json:"exists"`
	Writable   bool     `json:"writable"`
	FreeBytes  int64    `json:"free_bytes"`
	TotalBytes int64    `json:"total_bytes"`
	Models     int      `json:"models"`
	UsedBytes  int64    `json:"used_bytes"`
	// InUse is the model entries that load something from here, which is
	// what stops it being removed.
	InUse []string `json:"in_use"`
}

type ModelLocations struct {
	Locations []ModelLocation `json:"locations"`
	Max       int             `json:"max"`
}

// FolderListing is one directory as the location picker shows it: the
// folders in it, and the disks on the machine to jump to.
type FolderListing struct {
	Path   string `json:"path"`
	Parent string `json:"parent"`
	// Writable is whether a folder can be made here; Blocked, when set, is
	// why this directory cannot be a location itself.
	Writable bool          `json:"writable"`
	Blocked  string        `json:"blocked,omitempty"`
	Folders  []FolderEntry `json:"folders"`
	Disks    []Disk        `json:"disks"`
}

type FolderEntry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Blocked string `json:"blocked,omitempty"`
}

// Disk is one mounted filesystem a location could be on.
type Disk struct {
	Mount      string `json:"mount"`
	Device     string `json:"device"`
	FSType     string `json:"fstype"`
	System     bool   `json:"system"`
	FreeBytes  int64  `json:"free_bytes"`
	TotalBytes int64  `json:"total_bytes"`
}
