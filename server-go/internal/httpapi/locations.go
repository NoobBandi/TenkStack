package httpapi

import (
	"net/http"
)

// The model locations: where downloads land and models are read from.
// Changing them creates directories and decides what containers mount, so
// it is the file routes' kind of power: an administrator in a browser.

func (s *Server) readLocations(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.Models.ListLocations())
}

func (s *Server) addLocation(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	var in struct {
		Path  string `json:"path"`
		Label string `json:"label"`
	}
	if err := readJSON(r, &in); err != nil {
		fail(w, http.StatusBadRequest, "path is required")
		return
	}
	loc, err := s.Models.AddLocation(r.Context(), in.Path, in.Label)
	if refused(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, loc)
}

func (s *Server) labelLocation(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	var in struct {
		Label string `json:"label"`
	}
	if err := readJSON(r, &in); err != nil {
		fail(w, http.StatusBadRequest, "label is required")
		return
	}
	if refused(w, s.Models.LabelLocation(r.PathValue("key"), in.Label)) {
		return
	}
	writeJSON(w, http.StatusOK, s.Models.ListLocations())
}

// removeLocation also waits for downloads into it: removing the macro
// under a download would leave a file no entry can name.
func (s *Server) removeLocation(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	key := r.PathValue("key")
	if s.Catalog.ActiveIn(key) {
		fail(w, http.StatusConflict, "還有模型正在下載到這個位置，等下載完或取消後再移除")
		return
	}
	if refused(w, s.Models.RemoveLocation(r.Context(), key)) {
		return
	}
	writeJSON(w, http.StatusOK, s.Models.ListLocations())
}

func (s *Server) setLocationDefaults(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	var in map[string]string
	if err := readJSON(r, &in); err != nil {
		fail(w, http.StatusBadRequest, "a format to location map is required")
		return
	}
	if refused(w, s.Models.SetDefaults(in)) {
		return
	}
	writeJSON(w, http.StatusOK, s.Models.ListLocations())
}
