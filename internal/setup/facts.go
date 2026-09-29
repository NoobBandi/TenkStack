package setup

import (
	"os"
	"strings"
)

// Facts are install.sh's survey, handed to the screens so the one
// confirmation can list every change the chosen install makes to the
// machine: packages, groups, sudo steps and whether a reboot follows.
type Facts struct {
	MissingPkgs   []string // git, docker, caddy, nvidia-driver, ...
	MissingGroups []string // docker, render
	NeedsReboot   bool
	RebootWhy     string // already in the chosen language
	HaveSetcap    bool   // setcap is present (a public domain needs it)
	Linger        bool   // loginctl linger already on
	XPUFilter     bool   // the xpu-smi journal filter is already installed
	Intel         bool
	// BusyPorts are ports a choice would need that something already
	// listens on: 80 and 443 for a domain, SearXNG's.
	BusyPorts   []string
	SearXNGPort string
	TLSPort     string
	Host        string
	DryRun      bool
}

// ParseFacts reads the KEY="value" lines install.sh writes.
func ParseFacts(raw string) Facts {
	kv := map[string]string{}
	for _, line := range strings.Split(raw, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		kv[k] = strings.Trim(v, `"'`)
	}
	list := func(k string) []string { return strings.Fields(kv[k]) }
	yes := func(k string) bool { return kv[k] == "true" }
	f := Facts{
		MissingPkgs: list("MISSING_PKGS"), MissingGroups: list("MISSING_GROUPS"),
		NeedsReboot: yes("NEEDS_REBOOT"), RebootWhy: kv["REBOOT_WHY"],
		HaveSetcap: yes("HAVE_SETCAP"), Linger: yes("LINGER"), XPUFilter: yes("XPU_FILTER"),
		Intel: yes("INTEL"), BusyPorts: list("BUSY_PORTS"),
		SearXNGPort: kv["SEARXNG_PORT"], TLSPort: kv["CONSOLE_TLS_PORT"], Host: kv["HOST"],
		DryRun: yes("DRY_RUN"),
	}
	if f.TLSPort == "" {
		f.TLSPort = "8443"
	}
	if f.SearXNGPort == "" {
		f.SearXNGPort = "8090"
	}
	if f.Host == "" {
		f.Host, _ = os.Hostname()
	}
	return f
}

// Busy is the ports among those the answers need that are taken.
func (f Facts) Busy(a Answers) []string {
	need := map[string]bool{}
	if a.TLS == "domain" {
		need["80"], need["443"] = true, true
	}
	if a.SearXNG {
		need[f.SearXNGPort] = true
	}
	var out []string
	for _, p := range f.BusyPorts {
		if need[p] {
			out = append(out, p)
		}
	}
	return out
}

// Change is one line of the confirmation's system section.
type Change struct {
	Text string
	Sudo bool
}

// Changes are what the answers do to the machine beyond the install
// directory, in the order install.sh does them.
func (f Facts) Changes(l Lang, a Answers) []Change {
	var out []Change
	// Caddy is downloaded to ~/.local/bin and Go into the install
	// directory, as the user; everything else comes through apt or
	// Docker's installer, as root.
	var pkgs []string
	for _, p := range f.MissingPkgs {
		switch p {
		case "caddy":
			out = append(out, Change{T(l, "chg.caddy"), false})
		case "go":
		default:
			pkgs = append(pkgs, p)
		}
	}
	if a.TLS == "domain" && !f.HaveSetcap {
		pkgs = append(pkgs, "libcap2-bin")
	}
	if len(pkgs) > 0 {
		out = append(out, Change{Tf(l, "chg.pkgs", strings.Join(pkgs, ", ")), true})
	}
	if len(f.MissingGroups) > 0 {
		out = append(out, Change{Tf(l, "chg.groups", strings.Join(f.MissingGroups, ", ")), true})
	}
	switch a.TLS {
	case "internal":
		out = append(out, Change{T(l, "chg.trust"), true})
	case "domain":
		out = append(out, Change{T(l, "chg.setcap"), true})
	}
	if f.Intel && !f.XPUFilter {
		out = append(out, Change{T(l, "chg.xpufilter"), true})
	}
	if !f.Linger {
		out = append(out, Change{T(l, "chg.linger"), true})
	}
	return out
}
