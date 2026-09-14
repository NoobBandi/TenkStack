package httpapi

import (
	"errors"
	"net/http"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
	"github.com/NoobBandi/TenkStack/server-go/internal/channels"
	"github.com/NoobBandi/TenkStack/server-go/internal/network"
	"github.com/NoobBandi/TenkStack/server-go/internal/versions"
)

func (s *Server) readChannels(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.Channels.Status())
}

func channelError(w http.ResponseWriter, err error) {
	var apply *channels.ApplyError
	switch {
	case errors.Is(err, channels.ErrUnknown):
		fail(w, http.StatusNotFound, "no such channel")
	case errors.Is(err, channels.ErrMissing):
		fail(w, http.StatusConflict, err.Error())
	case errors.As(err, &apply):
		fail(w, http.StatusInternalServerError, apply.Msg)
	default:
		fail(w, http.StatusInternalServerError, err.Error())
	}
}

func (s *Server) writeChannel(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Enabled bool `json:"enabled"`
	}
	if err := readJSON(r, &in); err != nil {
		fail(w, http.StatusUnprocessableEntity, "invalid JSON body")
		return
	}
	st, err := s.Channels.SetEnabled(r.Context(), r.PathValue("name"), in.Enabled)
	if err != nil {
		channelError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) writeChannelScopes(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Scopes *[]string `json:"scopes"`
	}
	if err := readJSON(r, &in); err != nil || in.Scopes == nil {
		fail(w, http.StatusBadRequest, "scopes must be a list")
		return
	}
	st, err := s.Channels.SetScopes(r.Context(), r.PathValue("name"), *in.Scopes)
	if err != nil {
		channelError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

// endpoints mirrors the Caddyfile, each entry probed before it is shown.
func (s *Server) endpoints() []api.Endpoint {
	p := s.Ports
	return []api.Endpoint{
		{Key: "console", Label: "主控台", Scheme: "https", Port: p.ConsoleTLS, Path: "/",
			Note: "瀏覽器使用。憑證由本地 CA 簽發，首次連線需接受警告。", Encrypted: true},
		{Key: "api-http", Label: "API（純 HTTP）", Scheme: "http", Port: p.API, Path: "/v1",
			Note: "給不方便處理自簽憑證的用戶端，例如 Opencode。只開放 /v1，OpenAI 與 Anthropic 兩種格式都收，API key 在區網上是明文。"},
		{Key: "api-https", Label: "API（加密）", Scheme: "https", Port: p.ConsoleTLS, Path: "/v1",
			Note: "同一組端點但走 TLS：/v1/chat/completions 是 OpenAI 格式，/v1/messages 是 Anthropic 格式。用戶端需信任本地 CA。", Encrypted: true},
		{Key: "comfyui", Label: "ComfyUI", Scheme: "https", Port: p.ComfyPublicFirst, Path: "/",
			Note: "圖像生成的原生介面，由主控台的登入保護。", Encrypted: true},
	}
}

func (s *Server) readEndpoints(w http.ResponseWriter, _ *http.Request) {
	out := s.endpoints()
	for i := range out {
		out[i].Listening = network.PortOpen(out[i].Port)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) readNetwork(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, network.Hosts(r.Context()))
}

// readMachine is where this install lives and which of its units run.
func (s *Server) readMachine(w http.ResponseWriter, r *http.Request) {
	l := s.Layout
	paths := []api.MachinePath{}
	for _, p := range []struct{ variable, label, path string }{
		{"CONSOLE_AI_DIR", "根目錄", l.AIDir},
		{"CONSOLE_MODELS_DIR", "模型權重", l.ModelsDir},
		{"CONSOLE_LLAMA_SWAP_CONFIG", "llama-swap 設定", l.LlamaSwapConfig},
		{"CONSOLE_CADDY_DIR", "Caddy 設定", l.CaddyDir},
		{"CONSOLE_COMFYUI_DIR", "ComfyUI 儲存", l.ComfyDir},
		{"CONSOLE_STATE_DIR", "主控台資料", l.StateDir},
	} {
		paths = append(paths, api.MachinePath{Variable: p.variable, Label: p.label, Path: p.path, Exists: network.Exists(p.path)})
	}
	units := []api.MachineUnit{}
	for _, u := range []struct{ name, note string }{
		{"llama-swap.service", "模型生命週期，OpenAI／Anthropic 端點"},
		{"caddy.service", "TLS 與單一入口"},
		{"ai-console.service", "本服務"},
	} {
		unit := network.Unit(r.Context(), u.name)
		unit.Note = u.note
		units = append(units, unit)
	}
	writeJSON(w, http.StatusOK, api.Machine{Paths: paths, Units: units})
}

// readVersions probes every moving part; the build serving now comes from
// the first running model's props, device 0's driver from its discovery.
func (s *Server) readVersions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var running *string
	for _, entry := range s.LlamaSwap.Running(ctx) {
		if proxy, _ := entry["proxy"].(string); proxy != "" {
			if props := s.LlamaSwap.Props(ctx, proxy); props != nil {
				if b, _ := props["build_info"].(string); b != "" {
					running = &b
				}
			}
			break
		}
	}
	raw := map[string]any{}
	if d := s.Gpu.Detail(ctx, 0); d != nil {
		if m, ok := d.Raw.(map[string]any); ok {
			raw = m
		}
	}
	var macros [][2]string
	for _, l := range s.Config.LauncherList() {
		macros = append(macros, [2]string{l.Name, l.Path})
	}
	writeJSON(w, http.StatusOK, versions.Collect(ctx, versions.Inputs{
		LlamaSwapBin: s.Layout.LlamaSwapBin, CaddyBin: s.Layout.CaddyBin, LlamaCppDir: s.Layout.LlamaCppDir,
		OneAPIDir: s.Layout.OneAPIDir, Launchers: macros, ComfyPorts: s.Ports.ComfyPorts(),
		Running: running, GPU: raw, Console: s.Version,
	}))
}
