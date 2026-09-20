package httpapi

import (
	"errors"
	"net/http"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
	"github.com/NoobBandi/TenkStack/server-go/internal/quant"
)

// readQuant is the page's state: the tool per vendor with cards here, the
// schemes, and every job this process has run.
func (s *Server) readQuant(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	seen := map[string]bool{}
	tools := []api.QuantTool{}
	for _, c := range s.cards(ctx) {
		if !seen[c.Vendor] {
			seen[c.Vendor] = true
			tools = append(tools, s.Quant.Tool(ctx, c.Vendor))
		}
	}
	writeJSON(w, http.StatusOK, api.QuantPage{
		Tools: tools, Schemes: quant.Options(), Speeds: []string{"standard", "fast", "rtn"}, Jobs: s.Quant.Jobs(),
	})
}

func quantError(w http.ResponseWriter, err error) {
	var invalid *quant.Invalid
	if errors.As(err, &invalid) {
		fail(w, http.StatusBadRequest, invalid.Msg)
		return
	}
	fail(w, http.StatusInternalServerError, err.Error())
}

// buildQuantTool makes the derived image for one vendor. Owner-only, like
// everything that pulls or builds an image.
func (s *Server) buildQuantTool(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	var in struct {
		Vendor string `json:"vendor"`
	}
	if err := readJSON(r, &in); err != nil || in.Vendor == "" {
		fail(w, http.StatusUnprocessableEntity, "vendor is required")
		return
	}
	tool, err := s.Quant.Build(r.Context(), in.Vendor)
	if err != nil {
		quantError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, tool)
}

// startQuant begins one job. The card it runs on has to be free of models;
// the caller unloads first, the same as before a ComfyUI render.
func (s *Server) startQuant(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	var in struct {
		Source string `json:"source"`
		Scheme string `json:"scheme"`
		Speed  string `json:"speed"`
		Card   int    `json:"card"`
	}
	if err := readJSON(r, &in); err != nil || in.Source == "" || in.Scheme == "" {
		fail(w, http.StatusUnprocessableEntity, "source and scheme are required")
		return
	}
	if !quant.SafeName(in.Source) {
		fail(w, http.StatusBadRequest, "路徑不在模型目錄底下")
		return
	}
	job, err := s.Quant.Start(r.Context(), quant.Request{Source: in.Source, Scheme: in.Scheme, Speed: in.Speed, Card: in.Card})
	if err != nil {
		quantError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, job)
}

func (s *Server) cancelQuant(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	if !s.Quant.Cancel(r.PathValue("id")) {
		fail(w, http.StatusNotFound, "沒有這個正在跑的量化")
		return
	}
	writeJSON(w, http.StatusOK, api.OK{OK: true})
}
