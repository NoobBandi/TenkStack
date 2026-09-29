// Package ports is every port the console assumes, each an environment
// variable with the default this layout runs.
package ports

import (
	"os"
	"strconv"
)

type Ports struct {
	LlamaSwap  int // where llama-swap answers; /v1 is proxied here
	Console    int // the console's own backend, behind Caddy
	API        int // plain-HTTP /v1 for clients that refuse a private CA
	ConsoleTLS int // everything else, the interface and the encrypted /v1

	// ComfyUI containers take the first free port in a range; the width is
	// how many instances a machine may have.
	ComfyFirst       int
	ComfyCount       int
	ComfyPublicFirst int
}

func FromEnv() Ports {
	return Ports{
		LlamaSwap:        port("CONSOLE_LLAMA_SWAP_PORT", 8080),
		Console:          port("CONSOLE_PORT", 8070),
		API:              port("CONSOLE_API_PORT", 8000),
		ConsoleTLS:       port("CONSOLE_TLS_PORT", 8443),
		ComfyFirst:       port("CONSOLE_COMFYUI_PORT", 8188),
		ComfyCount:       port("CONSOLE_COMFYUI_COUNT", 4),
		ComfyPublicFirst: port("CONSOLE_COMFYUI_PUBLIC_PORT", 8444),
	}
}

// ComfyPorts are the loopback ports ComfyUI instances may publish on.
func (p Ports) ComfyPorts() []int {
	out := make([]int, 0, p.ComfyCount)
	for i := 0; i < p.ComfyCount; i++ {
		out = append(out, p.ComfyFirst+i)
	}
	return out
}

// Out-of-range is a typo, not a choice: the default beats binding to
// something arbitrary.
func port(name string, fallback int) int {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > 65535 {
		return fallback
	}
	return n
}
