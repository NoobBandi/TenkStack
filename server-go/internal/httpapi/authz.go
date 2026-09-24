package httpapi

import (
	"net/http"

	"github.com/NoobBandi/TenkStack/server-go/internal/auth"
)

// Who may do what. Signing in lets someone use the machine: chat, load and
// unload models, stop what ComfyUI is drawing, manage their own password
// and API keys. Changing it for everyone -- accounts, what is published to
// the internet, which models exist and what is on disk, ComfyUI's version --
// is the administrator's, from a browser. API keys never reach /api at all;
// the middleware keeps them to /v1.

// owner admits the administrator (or anyone while no account exists yet),
// and answers the request itself when it is someone else.
func (s *Server) owner(w http.ResponseWriter, r *http.Request) bool {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return false
	}
	return true
}

// caller is who is asking and whether they are the administrator. ok is
// false, with the response written, for a request nobody signed in made
// once accounts exist -- which the middleware already turns away.
func (s *Server) caller(w http.ResponseWriter, r *http.Request) (userID int64, isOwner, ok bool) {
	if _, d := s.Auth.RequireOwner(r); d == nil {
		if id := auth.Identity(r.Context()); id != nil {
			return id.UserID, true, true
		}
		return 0, true, true
	}
	id := auth.Identity(r.Context())
	if id == nil {
		fail(w, http.StatusUnauthorized, "請先登入")
		return 0, false, false
	}
	return id.UserID, false, true
}
