package httpapi

import (
	gocontext "context"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
	"github.com/NoobBandi/TenkStack/server-go/internal/network"
)

// searchUnit is the user unit install.sh writes for SearXNG. An older
// install ran it as a plain container instead, found by its image.
const searchUnit = "tenkstack-searxng.service"

// searchService says how the web search behind the agent is run on this
// machine: a unit, a container, or nothing.
func (s *Server) searchService(ctx gocontext.Context) api.SearchService {
	out := api.SearchService{}
	if unit, present := network.Unit(ctx, searchUnit); present && unit.Active != "unknown" {
		out.Installed, out.Unit, out.State, out.Since = true, searchUnit, unit.Active, unit.Since
		return out
	}
	for _, c := range s.Docker.Survey(ctx, nil).Containers {
		if c.Image == nil || !strings.Contains(*c.Image, "searxng") {
			continue
		}
		out.Installed, out.Container = true, c.Name
		if c.State != nil {
			out.State = *c.State
		}
		if c.Status != nil {
			out.Since = *c.Status
		}
		return out
	}
	return out
}

// readSearchService is the settings page's line for web search: whether
// it is installed, and whether it answers.
func (s *Server) readSearchService(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	out := s.searchService(r.Context())
	out.Available = s.Search.Available(r.Context())
	writeJSON(w, http.StatusOK, out)
}

// restartSearch restarts SearXNG through whatever runs it: its unit when
// there is one, so systemd's record of it stays true, else its container.
func (s *Server) restartSearch(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	svc := s.searchService(r.Context())
	switch {
	case svc.Unit != "":
		ctx, cancel := gocontext.WithTimeout(r.Context(), 60*time.Second)
		defer cancel()
		if out, err := exec.CommandContext(ctx, "systemctl", "--user", "restart", svc.Unit).CombinedOutput(); err != nil {
			fail(w, http.StatusBadGateway, "重啟失敗："+strings.TrimSpace(string(out)))
			return
		}
	case svc.Container != "":
		if !s.Docker.Control(r.Context(), svc.Container, "restart") {
			fail(w, http.StatusBadGateway, "重啟失敗："+svc.Container)
			return
		}
	default:
		fail(w, http.StatusNotFound, "這台機器沒有安裝搜尋服務")
		return
	}
	writeJSON(w, http.StatusOK, api.OK{OK: true})
}

// readOrphaned is the containers given a card this machine no longer has,
// which docker keeps starting regardless.
func (s *Server) readOrphaned(w http.ResponseWriter, r *http.Request) {
	out := []api.SurveyContainer{}
	for _, c := range s.Docker.Survey(r.Context(), s.cards(r.Context())).Containers {
		if c.Orphaned {
			out = append(out, c)
		}
	}
	writeJSON(w, http.StatusOK, out)
}
