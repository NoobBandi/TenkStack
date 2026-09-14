package httpapi

import (
	"errors"
	"net/http"

	"github.com/NoobBandi/TenkStack/server-go/internal/settings"
)

func (s *Server) readSettings(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.Settings.Describe())
}

// writeSettings is owner-only: these decide whether a chat request may
// evict somebody's image generation, and how many steps an agent may spend.
func (s *Server) writeSettings(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	var payload map[string]any
	if err := readJSON(r, &payload); err != nil {
		fail(w, http.StatusUnprocessableEntity, "invalid JSON body")
		return
	}
	values, err := s.Settings.Save(payload)
	if err != nil {
		var bad *settings.ValidationError
		if errors.As(err, &bad) {
			fail(w, http.StatusBadRequest, bad.Msg)
			return
		}
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Buffers that already exist are resized rather than waited for.
	s.History.SetHours(int(values["gpu_history_hours"]))
	writeJSON(w, http.StatusOK, s.Settings.Describe())
}

func (s *Server) readSystem(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.System.Sample())
}
