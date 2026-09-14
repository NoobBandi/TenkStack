// Package network answers how this host can be reached: which ports
// listen, which addresses it has, what Tailscale calls it, and which of
// its units are running.
package network

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
)

// PortOpen probes loopback with a short timeout.
func PortOpen(port int) bool {
	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", itoa(port)), 400*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func itoa(n int) string { return strconv.Itoa(n) }

// LAN asks the routing table which source address would reach the
// internet; no packet is sent.
func LAN() string {
	conn, err := net.Dial("udp", "1.1.1.1:80")
	if err != nil {
		return ""
	}
	defer conn.Close()
	if addr, ok := conn.LocalAddr().(*net.UDPAddr); ok {
		return addr.IP.String()
	}
	return ""
}

// Tailscale is this node's identity, or nil when tailscaled is not running.
// Only it knows the MagicDNS name and whether the tailnet issues certs.
func Tailscale(ctx context.Context) *api.Tailscale {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "tailscale", "status", "--json").Output()
	if err != nil {
		return nil
	}
	var status struct {
		BackendState string   `json:"BackendState"`
		CertDomains  []string `json:"CertDomains"`
		Self         struct {
			TailscaleIPs []string `json:"TailscaleIPs"`
			DNSName      string   `json:"DNSName"`
		} `json:"Self"`
	}
	if json.Unmarshal(out, &status) != nil {
		return nil
	}
	ts := &api.Tailscale{Running: status.BackendState == "Running", CertDomains: status.CertDomains}
	if ts.CertDomains == nil {
		ts.CertDomains = []string{}
	}
	for _, ip := range status.Self.TailscaleIPs {
		if !strings.Contains(ip, ":") {
			v := ip
			ts.IP = &v
			break
		}
	}
	if name := strings.TrimSuffix(status.Self.DNSName, "."); name != "" {
		ts.DNSName = &name
	}
	return ts
}

// Hosts is every address this host can be reached on, so the UI offers the
// right one rather than whichever the browser used.
func Hosts(ctx context.Context) api.Network {
	hosts := []api.Host{{Key: "local", Label: "本機", Host: "127.0.0.1", Note: "只有這台機器自己"}}
	if lan := LAN(); lan != "" {
		hosts = append(hosts, api.Host{Key: "lan", Label: "區域網路", Host: lan, Note: "同一個家用網路內的裝置"})
	}
	ts := Tailscale(ctx)
	if ts != nil && ts.Running {
		// The IPv4 address first: the MagicDNS name needs a certificate Caddy
		// cannot fetch without `tailscale set --operator`.
		if ts.IP != nil {
			f := false
			hosts = append(hosts, api.Host{Key: "tailscale-ip", Label: "Tailscale", Host: *ts.IP,
				Note: "任何地方都能連，流量由 WireGuard 加密", Tailscale: true, CertAvailable: &f})
		}
		if ts.DNSName != nil {
			avail := false
			for _, d := range ts.CertDomains {
				if d == *ts.DNSName {
					avail = true
				}
			}
			hosts = append(hosts, api.Host{Key: "tailscale-dns", Label: "Tailscale 網域", Host: *ts.DNSName,
				Note: "較好記，但需要先取得憑證才能走 HTTPS", Tailscale: true, CertAvailable: &avail})
		}
	}
	return api.Network{Hosts: hosts, Tailscale: ts}
}

// Unit is one user unit's state, asked of systemd. `show` answers for a
// unit that does not exist too.
func Unit(ctx context.Context, name string) api.MachineUnit {
	u := api.MachineUnit{Name: name, Active: "unknown"}
	out, err := exec.CommandContext(ctx, "systemctl", "--user", "show", name,
		"-p", "ActiveState", "-p", "SubState", "-p", "ExecMainStartTimestamp").Output()
	if err != nil && len(out) == 0 {
		return u
	}
	fields := map[string]string{}
	for _, line := range strings.Split(string(out), "\n") {
		if k, v, ok := strings.Cut(line, "="); ok {
			fields[k] = v
		}
	}
	if v := fields["ActiveState"]; v != "" {
		u.Active = v
	}
	u.Sub = fields["SubState"]
	u.Since = fields["ExecMainStartTimestamp"]
	return u
}

func Exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
