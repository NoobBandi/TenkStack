// Package paths resolves where everything lives: one environment variable per
// location, each with a default under CONSOLE_AI_DIR. Nothing here creates
// directories; a missing one is a condition the caller reports.
package paths

import (
	"os"
	"path/filepath"
	"strings"
)

type Layout struct {
	AIDir      string
	StateDir   string
	SessionKey string
	// Postgres holds the console's database (pgserver); SQLite is where
	// versions before it kept their data, read once to import it.
	Postgres  string
	SQLite    string
	ModelsDir string

	LlamaSwapDir      string
	LlamaSwapConfig   string
	LlamaSwapBin      string
	LlamaSwapActivity string

	LlamaCppDir string
	ComfyDir    string
	CaddyDir    string
	CaddyBin    string
	OneAPIDir   string
}

func FromEnv() Layout {
	ai := env("CONSOLE_AI_DIR", "~/ai")
	state := env("CONSOLE_STATE_DIR", filepath.Join(ai, "ai-console"))
	swap := env("CONSOLE_LLAMA_SWAP_DIR", filepath.Join(ai, "llama-swap"))
	return Layout{
		AIDir:      ai,
		StateDir:   state,
		SessionKey: filepath.Join(state, "session.key"),
		Postgres:   filepath.Join(state, "postgres"),
		SQLite:     filepath.Join(state, "console.sqlite"),
		ModelsDir:  env("CONSOLE_MODELS_DIR", filepath.Join(ai, "models")),

		LlamaSwapDir:      swap,
		LlamaSwapConfig:   env("CONSOLE_LLAMA_SWAP_CONFIG", filepath.Join(swap, "config.yaml")),
		LlamaSwapBin:      env("CONSOLE_LLAMA_SWAP_BIN", filepath.Join(swap, "llama-swap")),
		LlamaSwapActivity: env("CONSOLE_LLAMA_SWAP_ACTIVITY", filepath.Join(swap, "activity.sqlite")),

		LlamaCppDir: env("CONSOLE_LLAMA_CPP_DIR", filepath.Join(ai, "llama.cpp")),
		ComfyDir:    env("CONSOLE_COMFYUI_DIR", filepath.Join(ai, "comfyui")),
		CaddyDir:    env("CONSOLE_CADDY_DIR", filepath.Join(ai, "caddy")),
		CaddyBin:    env("CONSOLE_CADDY_BIN", "~/.local/bin/caddy"),
		OneAPIDir:   env("CONSOLE_ONEAPI_DIR", "/opt/intel/oneapi"),
	}
}

func env(name, fallback string) string {
	v := os.Getenv(name)
	if v == "" {
		v = fallback
	}
	return expandHome(v)
}

func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, err := os.UserHomeDir()
		if err == nil {
			return filepath.Join(home, p[1:])
		}
	}
	return p
}
