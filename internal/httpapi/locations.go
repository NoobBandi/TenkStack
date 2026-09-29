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

// updateLocation renames a location and, with a path, repoints it; not
// while a download is writing into it, which would land at the old path.
func (s *Server) updateLocation(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	var in struct {
		Label string  `json:"label"`
		Path  *string `json:"path"`
	}
	if err := readJSON(r, &in); err != nil {
		fail(w, http.StatusBadRequest, "label is required")
		return
	}
	key := r.PathValue("key")
	if in.Path != nil && s.Catalog.ActiveIn(key) {
		fail(w, http.StatusConflict, "還有模型正在下載到這個位置，等下載完或取消後再改路徑")
		return
	}
	if refused(w, s.Models.UpdateLocation(r.Context(), key, in.Label, in.Path)) {
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

// browseFolders lists a directory for the location picker. It names the
// machine's folders, so it is an administrator's, like adding one.
func (s *Server) browseFolders(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	out, err := s.Models.Browse(r.URL.Query().Get("path"))
	if refused(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, out)
}
