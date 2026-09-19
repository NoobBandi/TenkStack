package httpapi

import (
	gocontext "context"
	"errors"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
	"github.com/NoobBandi/TenkStack/server-go/internal/backends"
	"github.com/NoobBandi/TenkStack/server-go/internal/flags"
	"github.com/NoobBandi/TenkStack/server-go/internal/llamaswap"
	"github.com/NoobBandi/TenkStack/server-go/internal/vendors"
)

// cardsOf is the GPU list as the container side sees it.
// cards is the inventory alone -- index, name, vendor, address -- which is
// all that mapping containers to cards needs. ListDevices also attaches
// each card's detail and a live sample, two subprocesses per card, and a
// handler that only wants to know which card is which should not pay
// that on every call.
func (s *Server) cards(ctx gocontext.Context) []vendors.Card {
	found := s.Gpu.Discover(ctx)
	out := make([]vendors.Card, 0, len(found))
	for _, d := range found {
		address := ""
		if d.PCIBDFAddress != nil {
			address = *d.PCIBDFAddress
		}
		out = append(out, vendors.Card{PCIBDFAddress: address, Name: d.Name, Vendor: d.Vendor})
	}
	return out
}

func cardsOf(devices []api.GpuDevice) []vendors.Card {
	out := make([]vendors.Card, 0, len(devices))
	for _, d := range devices {
		address := ""
		if d.PCIBDFAddress != nil {
			address = *d.PCIBDFAddress
		}
		out = append(out, vendors.Card{PCIBDFAddress: address, Name: d.Name, Vendor: d.Vendor})
	}
	return out
}

// readBackendDevices is the cards a configured llama-server can see, not
// the GPU list: a card with no runtime cannot run a model.
func (s *Server) readBackendDevices(w http.ResponseWriter, r *http.Request) {
	refresh := r.URL.Query().Get("refresh")
	usable := s.Backends.Usable(r.Context(), refresh == "true" || refresh == "1")
	writeJSON(w, http.StatusOK, backends.Match(usable, s.Gpu.ListDevices(r.Context())))
}

func (s *Server) readRuntime(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.Docker.Survey(r.Context(), cardsOf(s.Gpu.ListDevices(r.Context()))))
}

// runtimeContainer restarts one container. Owner-only: an API key pasted
// into a chat client implies no right to bounce the image generator.
func (s *Server) runtimeContainer(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	var in struct {
		Name string `json:"name"`
		Verb string `json:"verb"`
	}
	if err := readJSON(r, &in); err != nil {
		fail(w, http.StatusUnprocessableEntity, "invalid JSON body")
		return
	}
	if in.Verb == "" {
		in.Verb = "restart"
	}
	if !s.Docker.Control(r.Context(), in.Name, in.Verb) {
		fail(w, http.StatusNotFound, "無法對 "+in.Name+" 執行 "+in.Verb)
		return
	}
	writeJSON(w, http.StatusOK, api.OK{OK: true})
}

func (s *Server) readLlamaFlags(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	fallback := filepath.Join(s.Layout.LlamaCppDir, "builds", "current", "bin", "llama-server")
	found := s.Flags.LlamaServer(r.Context(), s.Config.Launchers(), fallback)
	writeJSON(w, http.StatusOK, api.FlagsPage{Flags: flags.Configurable(found)})
}

func (s *Server) readComfyFlags(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	container := r.URL.Query().Get("container")
	if !strings.HasPrefix(container, "comfyui-") {
		fail(w, http.StatusBadRequest, "不是 ComfyUI 容器")
		return
	}
	found := s.Flags.Comfy(r.Context(), container, s.Docker.ImageOf(r.Context(), container))
	writeJSON(w, http.StatusOK, api.FlagsPage{Flags: flags.Configurable(found)})
}

func (s *Server) readConfig(w http.ResponseWriter, _ *http.Request) {
	raw, err := s.Config.Raw()
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	c, err := s.Config.Load()
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, api.ConfigPage{
		Raw: raw, Models: llamaswap.Section(c, "models"), Groups: llamaswap.Section(c, "groups"), Path: s.Config.Path,
	})
}

func (s *Server) writeConfig(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Raw *string `json:"raw"`
	}
	if err := readJSON(r, &in); err != nil || in.Raw == nil {
		fail(w, http.StatusBadRequest, "'raw' must be a string")
		return
	}
	if err := s.Config.WriteRaw(r.Context(), *in.Raw); err != nil {
		var parse *llamaswap.ParseError
		if errors.As(err, &parse) || errors.Is(err, llamaswap.Rejected) {
			fail(w, http.StatusBadRequest, err.Error())
			return
		}
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, api.OK{OK: true})
}
