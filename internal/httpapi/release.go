package httpapi

import "net/http"

// The newest release on GitHub against this installation. Anyone signed
// in may look; asking GitHub afresh and replacing the binary are the
// owner's.

func (s *Server) readRelease(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.Release.Latest(r.Context(), false))
}

func (s *Server) checkRelease(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	writeJSON(w, http.StatusOK, s.Release.Latest(r.Context(), true))
}

func (s *Server) applyRelease(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	out, err := s.Release.Apply(r.Context())
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}
