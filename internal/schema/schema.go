// Package schema is the wire format shared with the parameter workshop: what
// a benchmark run reports and what a recommendation carries. It mirrors §4 of
// the workshop devlog (tenkstack-workshop-devlog.md); the workshop is a
// separate service, and these types are what crosses between the two, so a
// change here is a change to a published format (bump BenchV1/RecommendV1).
package schema

import (
	"encoding/json"
	"fmt"
	"strconv"
)

const (
	RecommendV1 = "tenkstack.recommend.v1"
	BenchV1     = "tenkstack.bench.v1"
)

type Client struct {
	Name    string `json:"name"` // "tenkstack"
	Version string `json:"version"`
}

type GPU struct {
	Vendor  string `json:"vendor"` // intel | nvidia | amd
	Model   string `json:"model"`
	VRAMMiB int    `json:"vram_mib"`
	Count   int    `json:"count"`
	PCIe    string `json:"pcie,omitempty"`
}

type CPU struct {
	Model string `json:"model"`
}

type HardwareProfile struct {
	GPU    GPU `json:"gpu"`
	CPU    CPU `json:"cpu"`
	RAMMiB int `json:"ram_mib"`
}

type ModelRef struct {
	Format   string `json:"format"` // gguf | safetensors
	Repo     string `json:"repo,omitempty"`
	Revision string `json:"revision,omitempty"`
	File     string `json:"file,omitempty"`
	SHA256   string `json:"sha256,omitempty"`
	Quant    string `json:"quant"`
}

type EngineRef struct {
	Key     string `json:"key"` // llamacpp | vllm | sglang | strata | other
	Version string `json:"version"`
	Image   string `json:"image,omitempty"`
}

type KVCache struct {
	TypeK          string `json:"type_k,omitempty"`
	TypeV          string `json:"type_v,omitempty"`
	Unified        *bool  `json:"unified,omitempty"`
	PerSlotContext *int   `json:"per_slot_context,omitempty"`
	HostCacheMiB   *int   `json:"host_cache_mib,omitempty"`
}

type Rope struct {
	Scaling         string  `json:"scaling"` // yarn | linear
	Factor          float64 `json:"factor"`
	OriginalContext *int    `json:"original_context,omitempty"`
}

type NGram struct {
	Mode string `json:"mode,omitempty"` // the engine's own variant name: simple, cache, mod, map-k, map-k4v, ...
	// 0 is the engine's default, left out.
	NMatch int `json:"n_match,omitempty"`
	NMin   int `json:"n_min,omitempty"`
	NMax   int `json:"n_max,omitempty"`
}

type Speculative struct {
	Methods    []string  `json:"methods"` // mtp | eagle | eagle3 | dflash | dspark | draft | ngram
	NumTokens  *int      `json:"num_tokens,omitempty"`
	NGram      *NGram    `json:"ngram,omitempty"`
	DraftModel *ModelRef `json:"draft_model,omitempty"`
}

type Batch struct {
	BatchSize        *int `json:"batch_size,omitempty"`
	UBatchSize       *int `json:"ubatch_size,omitempty"`
	MaxBatchedTokens *int `json:"max_batched_tokens,omitempty"`
}

type MultiGPU struct {
	SplitMode   string    `json:"split_mode,omitempty"` // layer | tensor | row
	TensorSplit []float64 `json:"tensor_split,omitempty"`
}

type Switch struct {
	Enabled bool   `json:"enabled"`
	Parser  string `json:"parser,omitempty"`
}

type Sampling struct {
	Temperature     *float64 `json:"temperature,omitempty"`
	TopP            *float64 `json:"top_p,omitempty"`
	TopK            *int     `json:"top_k,omitempty"`
	MinP            *float64 `json:"min_p,omitempty"`
	RepeatPenalty   *float64 `json:"repeat_penalty,omitempty"`
	PresencePenalty *float64 `json:"presence_penalty,omitempty"`
}

// GPULayers is a count or the string "all".
type GPULayers struct {
	All   bool
	Count int
}

type Tuning struct {
	ContextLength        int          `json:"context_length"`
	KVCache              *KVCache     `json:"kv_cache,omitempty"`
	Rope                 *Rope        `json:"rope,omitempty"`
	Speculative          *Speculative `json:"speculative,omitempty"`
	MaxConcurrency       *int         `json:"max_concurrency,omitempty"`
	Batch                *Batch       `json:"batch,omitempty"`
	MultiGPU             *MultiGPU    `json:"multi_gpu,omitempty"`
	FlashAttention       *bool        `json:"flash_attention,omitempty"`
	OnlineQuantization   *string      `json:"online_quantization,omitempty"`
	GPUMemoryUtilization *float64     `json:"gpu_memory_utilization,omitempty"`
	GPULayers            *GPULayers   `json:"gpu_layers,omitempty"` // a number, or "all"
	CPUMoELayers         *int         `json:"cpu_moe_layers,omitempty"`
	Vision               *bool        `json:"vision,omitempty"`
	Reasoning            *Switch      `json:"reasoning,omitempty"`
	Tools                *Switch      `json:"tools,omitempty"`
	PrefixCache          *bool        `json:"prefix_cache,omitempty"`
	Sampling             *Sampling    `json:"sampling,omitempty"`
}

type RecommendRequest struct {
	Schema   string          `json:"schema"`
	Client   Client          `json:"client"`
	Hardware HardwareProfile `json:"hardware"`
	Model    ModelRef        `json:"model"`
	Engines  []EngineRef     `json:"engines"`
}

type ScoreSummary struct {
	GenTPS1k     float64            `json:"gen_tps_1k"`
	GenTPS32k    *float64           `json:"gen_tps_32k,omitempty"`
	TTFTMs1k     float64            `json:"ttft_ms_1k"`
	TotalTPS4Way *float64           `json:"total_tps_4way,omitempty"`
	ByContent    map[string]float64 `json:"by_content,omitempty"` // zh | en | code
}

type Recommendation struct {
	RecipeID string    `json:"recipe_id"`
	Engine   EngineRef `json:"engine"`
	Tuning   Tuning    `json:"tuning"`
	Match    struct {
		CPU string `json:"cpu"` // same | different
		RAM string `json:"ram"` // enough
	} `json:"match"`
	Requires struct {
		RAMPeakMiB int `json:"ram_peak_mib"`
	} `json:"requires"`
	Score         ScoreSummary `json:"score"`
	Reproductions int          `json:"reproductions"`
	UpdatedAt     string       `json:"updated_at"`
}

type RecommendResponse struct {
	Results []Recommendation `json:"results"`
}

type BenchCase struct {
	ID          string   `json:"id"`
	DepthTokens int      `json:"depth_tokens"`
	Concurrency int      `json:"concurrency"`
	Content     string   `json:"content"` // zh | en | code
	PromptRef   string   `json:"prompt_ref"`
	Repeats     int      `json:"repeats"`
	Tiers       []string `json:"tiers"` // quick | full
}

type BenchSuite struct {
	ID             string  `json:"id"`
	Version        string  `json:"version"`
	OutputTokens   int     `json:"output_tokens"`
	IgnoreEOS      bool    `json:"ignore_eos"`
	MinOutputRatio float64 `json:"min_output_ratio"`
	Thinking       bool    `json:"thinking"`
	UniquePrefix   bool    `json:"unique_prefix"`
	Sampling       struct {
		Temperature float64 `json:"temperature"`
		Seed        int     `json:"seed"`
	} `json:"sampling"`
	Warmup  int               `json:"warmup"`
	Cases   []BenchCase       `json:"cases"`
	Prompts map[string]string `json:"prompts"`
}

type CaseResult struct {
	CaseID       string   `json:"case_id"`
	TTFTMs       float64  `json:"ttft_ms"`
	PromptTPS    float64  `json:"prompt_tps"`
	GenTPS       float64  `json:"gen_tps"`
	TotalGenTPS  *float64 `json:"total_gen_tps,omitempty"`
	AcceptRate   *float64 `json:"accept_rate,omitempty"`
	GenTPSStdev  float64  `json:"gen_tps_stdev"`
	Samples      int      `json:"samples"`
	OutputTokens float64  `json:"output_tokens"`
	IgnoreEOS    bool     `json:"ignore_eos"`
}

type BenchSubmission struct {
	Schema            string          `json:"schema"`
	Client            Client          `json:"client"`
	Suite             SuiteRef        `json:"suite"`
	Hardware          HardwareProfile `json:"hardware"`
	Engine            EngineRef       `json:"engine"`
	Model             ModelRef        `json:"model"`
	Tuning            Tuning          `json:"tuning"`
	UnrecognizedFlags []string        `json:"unrecognized_flags"`
	Results           []CaseResult    `json:"results"`
	Resources         Resources       `json:"resources"`
	Run               RunInfo         `json:"run"`
	Reproduces        string          `json:"reproduces,omitempty"`
}

func (g GPULayers) MarshalJSON() ([]byte, error) {
	if g.All {
		return []byte(`"all"`), nil
	}
	return []byte(strconv.Itoa(g.Count)), nil
}

func (g *GPULayers) UnmarshalJSON(b []byte) error {
	var s string
	if json.Unmarshal(b, &s) == nil {
		if s != "all" {
			return fmt.Errorf("gpu_layers: %q is neither a number nor \"all\"", s)
		}
		*g = GPULayers{All: true}
		return nil
	}
	var n int
	if err := json.Unmarshal(b, &n); err != nil {
		return fmt.Errorf("gpu_layers: %w", err)
	}
	*g = GPULayers{Count: n}
	return nil
}

// SuiteRef names the test suite a run followed.
type SuiteRef struct {
	ID      string `json:"id"`
	Version string `json:"version"`
}

// Resources are the peaks seen while the suite ran.
type Resources struct {
	VRAMPeakMiB []int `json:"vram_peak_mib"` // one per card the model uses
	RAMPeakMiB  int   `json:"ram_peak_mib"`
}

// RunInfo is how the run itself went.
type RunInfo struct {
	StartedAt      string   `json:"started_at"`
	DurationS      float64  `json:"duration_s"`
	Tier           string   `json:"tier"`
	ColdStartS     *float64 `json:"cold_start_s,omitempty"`
	ExternalPaused bool     `json:"external_paused"`
	Clean          bool     `json:"clean"`
}
