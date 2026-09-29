package api

type Channel struct {
	Key       string   `json:"key"`
	Enabled   bool     `json:"enabled"`
	Present   bool     `json:"present"`
	Scopes    []string `json:"scopes"`
	Ports     []int    `json:"ports"`
	Label     string   `json:"label"`
	Port      int      `json:"port"`
	Encrypted bool     `json:"encrypted"`
	Note      string   `json:"note"`
}

type Channels struct {
	Changed   *bool              `json:"changed,omitempty"`
	Channels  []Channel          `json:"channels"`
	Addresses map[string]*string `json:"addresses"`
}

type Endpoint struct {
	Key       string `json:"key"`
	Label     string `json:"label"`
	Scheme    string `json:"scheme"`
	Port      int    `json:"port"`
	Path      string `json:"path"`
	Note      string `json:"note"`
	Encrypted bool   `json:"encrypted"`
	Listening bool   `json:"listening"`
}

type Host struct {
	Key           string `json:"key"`
	Label         string `json:"label"`
	Host          string `json:"host"`
	Note          string `json:"note"`
	Tailscale     bool   `json:"tailscale,omitempty"`
	CertAvailable *bool  `json:"cert_available,omitempty"`
}

type Tailscale struct {
	Running     bool     `json:"running"`
	IP          *string  `json:"ip"`
	DNSName     *string  `json:"dns_name"`
	CertDomains []string `json:"cert_domains"`
}

type Network struct {
	Hosts     []Host     `json:"hosts"`
	Tailscale *Tailscale `json:"tailscale"`
}

type MachinePath struct {
	Variable string `json:"variable"`
	Label    string `json:"label"`
	Path     string `json:"path"`
	Exists   bool   `json:"exists"`
}

type MachineUnit struct {
	Name   string `json:"name"`
	Active string `json:"active"`
	Sub    string `json:"sub"`
	Since  string `json:"since"`
	Note   string `json:"note"`
}

type Machine struct {
	Paths []MachinePath `json:"paths"`
	Units []MachineUnit `json:"units"`
}

type LauncherVersion struct {
	Launcher string `json:"launcher"`
	Version  string `json:"version"`
	Built    string `json:"built"`
}

type Inference struct {
	Launchers []LauncherVersion `json:"launchers"`
	Running   *string           `json:"running"`
	Source    *string           `json:"source"`
	Swap      *string           `json:"swap"`
}

type ComfyVersion struct {
	Port    int     `json:"port"`
	Device  string  `json:"device"`
	ComfyUI any     `json:"comfyui"`
	PyTorch any     `json:"pytorch"`
	Python  *string `json:"python"`
}

type LabelValue struct {
	Label string `json:"label"`
	Value any    `json:"value"`
}

type Versions struct {
	Inference Inference      `json:"inference"`
	ComfyUI   []ComfyVersion `json:"comfyui"`
	Console   string         `json:"console"`
	System    []LabelValue   `json:"system"`
}
