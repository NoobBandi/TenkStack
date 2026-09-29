package api

// GpuSample is one live reading. Nil means the vendor does not report it.
type GpuSample struct {
	Index             int      `json:"index"`
	Name              string   `json:"name"`
	PowerW            *float64 `json:"power_w"`
	MemoryUsedMiB     *float64 `json:"memory_used_mib"`
	MemoryTotalMiB    *float64 `json:"memory_total_mib"`
	MemoryUtilPercent *float64 `json:"memory_util_percent"`
	FrequencyMHz      *float64 `json:"frequency_mhz"`
	TemperatureC      *float64 `json:"temperature_c"`
	PowerCapW         *float64 `json:"power_cap_w"`
	FrequencyMaxMHz   *float64 `json:"frequency_max_mhz"`
	TemperatureCritC  *float64 `json:"temperature_crit_c"`
	Vendor            string   `json:"vendor"`
	Busy              bool     `json:"busy"`
}

type GpuUnavailable struct {
	Error string `json:"error"`
}

type DetailRow struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Value string `json:"value"`
}

type DetailGroup struct {
	Title string      `json:"title"`
	Rows  []DetailRow `json:"rows"`
}

type GpuDetail struct {
	Index  int           `json:"index"`
	Name   *string       `json:"name"`
	Groups []DetailGroup `json:"groups"`
	Raw    any           `json:"raw"`
}

type GpuDevice struct {
	Index         int           `json:"index"`
	Name          *string       `json:"name"`
	DRMDevice     *string       `json:"drm_device"`
	PCIBDFAddress *string       `json:"pci_bdf_address"`
	State         *string       `json:"state"`
	Vendor        string        `json:"vendor"`
	Groups        []DetailGroup `json:"groups"`
	Live          *GpuSample    `json:"live"`
	// PCIe is the link into the board, nil where sysfs does not say.
	PCIe *PCIeLink `json:"pcie"`
}

// PCIeLink is how a card is connected to the board.
type PCIeLink struct {
	// Link is what the card and its slot agree on: "PCIe 4.0 x8".
	Link string `json:"link"`
	// Card is what the card itself can do: "PCIe 5.0 x16".
	Card string `json:"card"`
	// SlotLimited: the slot is slower or narrower than the card.
	SlotLimited bool `json:"slot_limited"`
	// NarrowerNow is the lane count when fewer than Link's are connected,
	// else 0.
	NarrowerNow int `json:"narrower_now,omitempty"`
}

// GpuOccupant is one thing holding a card: a loaded model or a container.
type GpuOccupant struct {
	// Kind is "model" or "container".
	Kind string `json:"kind"`
	Name string `json:"name"`
	// Engine is the model's inference engine: llama.cpp, vLLM.
	Engine string `json:"engine,omitempty"`
	// State is llama-swap's for a model, docker's for a container.
	State string `json:"state"`
	// Cards is how many cards it spans.
	Cards int `json:"cards"`
}

type GpuHistoryPoint struct {
	T     float64  `json:"t"`
	Power *float64 `json:"power"`
	Vram  *float64 `json:"vram"`
	Freq  *float64 `json:"freq"`
	Temp  *float64 `json:"temp"`
	Util  *float64 `json:"util"`
}

type GpuHistory struct {
	Interval float64                      `json:"interval"`
	Devices  map[string][]GpuHistoryPoint `json:"devices"`
}
