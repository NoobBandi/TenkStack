package api

// BackendDevice is one card a configured llama-server can see.
type BackendDevice struct {
	Backend  string            `json:"backend"`
	Index    int               `json:"index"`
	Name     string            `json:"name"`
	TotalMiB int               `json:"total_mib"`
	Launcher string            `json:"launcher"`
	Env      map[string]string `json:"env"`
	// Set by Match; nil when no card of that name is free to attach.
	PCIBDFAddress *string `json:"pci_bdf_address,omitempty"`
}

type CardRef struct {
	PCIBDFAddress string  `json:"pci_bdf_address"`
	Name          *string `json:"name"`
	Vendor        string  `json:"vendor"`
}

type SurveyContainer struct {
	Name          string    `json:"name"`
	Image         *string   `json:"image"`
	State         *string   `json:"state"`
	Status        *string   `json:"status"`
	Ports         string    `json:"ports"`
	Created       *string   `json:"created"`
	RestartPolicy string    `json:"restart_policy"`
	WantsGPU      bool      `json:"wants_gpu"`
	Cards         []CardRef `json:"cards"`
	// Orphaned is the case worth shouting about: a card it was given is not
	// in this machine any more, and docker keeps starting it regardless.
	Orphaned bool `json:"orphaned"`
}

type Survey struct {
	Available  bool              `json:"available"`
	Containers []SurveyContainer `json:"containers"`
	IdleGPUs   []CardRef         `json:"idle_gpus"`
}

// Flag is one switch, as its own program describes it.
type Flag struct {
	Names      []string `json:"names"`
	Group      string   `json:"group"`
	Help       string   `json:"help"`
	TakesValue bool     `json:"takes_value"`
}

type FlagsPage struct {
	Flags []Flag `json:"flags"`
}

type ConfigPage struct {
	Raw    string         `json:"raw"`
	Models map[string]any `json:"models"`
	Groups map[string]any `json:"groups"`
	Path   string         `json:"path"`
}
