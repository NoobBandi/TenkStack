package api

type ComfyManager struct {
	Processing bool `json:"processing"`
	Done       any  `json:"done"`
	Total      any  `json:"total"`
}

// ComfyInstance is one ComfyUI as it answers on its port.
type ComfyInstance struct {
	Port         int            `json:"port"`
	PublicPort   *int           `json:"public_port"`
	Version      any            `json:"version"`
	Python       string         `json:"python"`
	Torch        any            `json:"torch"`
	Device       map[string]any `json:"device"`
	QueueRunning int            `json:"queue_running"`
	QueuePending int            `json:"queue_pending"`
	Manager      *ComfyManager  `json:"manager"`
	// Stale means it stopped answering and these are the last numbers it
	// gave: the normal state during a generation, not a fault.
	Stale bool `json:"stale"`
}

type ComfyTemplate struct {
	Label    string `json:"label"`
	Image    string `json:"image"`
	Verified bool   `json:"verified"`
	Vendor   string `json:"vendor"`
}

// Job is one long ComfyUI operation, polled by the page.
type Job struct {
	Card        string `json:"card"`
	Action      string `json:"action"` // create or update
	State       string `json:"state"`  // pulling, starting, done, error
	LayersDone  int    `json:"layers_done"`
	LayersTotal int    `json:"layers_total"`
	Message     string `json:"message"`
}

type ComfyState struct {
	Template  *ComfyTemplate `json:"template"`
	Container *string        `json:"container"`
	Image     *string        `json:"image"`
	ImageSize *string        `json:"image_size"`
	Slot      string         `json:"slot"`
	Job       *Job           `json:"job"`
}

// Install is one runtime being added.
type Install struct {
	Vendor      string `json:"vendor"`
	Image       string `json:"image"`
	State       string `json:"state"` // pulling, writing, done, error
	LayersDone  int    `json:"layers_done"`
	LayersTotal int    `json:"layers_total"`
	Message     string `json:"message"`
}

type RuntimeTemplate struct {
	Label    string   `json:"label"`
	Image    string   `json:"image"`
	Requires *string  `json:"requires"`
	Verified bool     `json:"verified"`
	Flags    []string `json:"flags"`
	Vendor   string   `json:"vendor"`
}

// RuntimeState is three independent facts: the script, the macro, the
// image. A disabled runtime is a script with no macro.
type RuntimeState struct {
	Managed   bool     `json:"managed"`
	Enabled   bool     `json:"enabled"`
	Image     *string  `json:"image"`
	ImageSize *string  `json:"image_size"`
	Install   *Install `json:"install"`
	UsedBy    []string `json:"used_by"`
}

type HeldContainer struct {
	Name  string  `json:"name"`
	State *string `json:"state"`
	Image *string `json:"image"`
	Ports string  `json:"ports"`
}

// RuntimeRow is what one card is currently for: models, images, both or
// nothing. Every field is observed.
type RuntimeRow struct {
	PCIBDFAddress *string          `json:"pci_bdf_address"`
	Name          *string          `json:"name"`
	Vendor        string           `json:"vendor"`
	LLM           bool             `json:"llm"`
	Containers    []HeldContainer  `json:"containers"`
	Images        bool             `json:"images"`
	SharedSwitch  bool             `json:"shared_switch"`
	Runtime       *RuntimeTemplate `json:"runtime"`
	State         *RuntimeState    `json:"state"`
	Comfy         *ComfyState      `json:"comfy,omitempty"`
}

type ComfyConfigCard struct {
	PCIBDFAddress *string `json:"pci_bdf_address"`
	Name          *string `json:"name"`
	Vendor        string  `json:"vendor"`
	Held          bool    `json:"held"`
}

type ComfyConfig struct {
	Name       string            `json:"name"`
	CLIArgs    string            `json:"cli_args"`
	Port       *int              `json:"port"`
	PublicPort *int              `json:"public_port"`
	Ports      []int             `json:"ports"`
	Devices    []string          `json:"devices"`
	Cards      []ComfyConfigCard `json:"cards"`
}

type UpdateAvailable struct {
	Available bool `json:"available"`
}

type LoadResult struct {
	OK     bool `json:"ok"`
	Status int  `json:"status"`
}

type JobStarted struct {
	OK  bool `json:"ok"`
	Job Job  `json:"job"`
}
