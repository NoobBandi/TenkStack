package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
	"github.com/NoobBandi/TenkStack/server-go/internal/auth"
	"github.com/NoobBandi/TenkStack/server-go/internal/chats"
	"github.com/NoobBandi/TenkStack/server-go/internal/search"
)

// callerID is whose conversations these are; nil before any account
// exists, which is the same state in which authentication is off.
func callerID(r *http.Request) *int64 {
	if id := auth.Identity(r.Context()); id != nil {
		v := id.UserID
		return &v
	}
	return nil
}

func (s *Server) listChats(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	var rows []api.ChatRow
	var err error
	if q != "" {
		rows, err = s.Chats.Search(q, callerID(r), 50)
	} else {
		rows, err = s.Chats.List(callerID(r), 200)
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

func (s *Server) saveChat(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID       *int64           `json:"id"`
		Model    string           `json:"model"`
		Params   map[string]any   `json:"params"`
		Messages []map[string]any `json:"messages"`
		Title    *string          `json:"title"`
	}
	if err := readJSON(r, &in); err != nil {
		fail(w, http.StatusUnprocessableEntity, "invalid JSON body")
		return
	}
	id, err := s.Chats.Save(in.ID, in.Messages, in.Model, in.Params, callerID(r), in.Title)
	if err != nil {
		var missing *chats.ErrNoConversation
		if errors.As(err, &missing) {
			fail(w, http.StatusNotFound, "no such conversation")
			return
		}
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, api.ChatSaved{ID: id})
}

func (s *Server) readChat(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "id")
	if !ok {
		return
	}
	c, err := s.Chats.Get(id)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if c == nil {
		fail(w, http.StatusNotFound, "no such conversation")
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) patchChat(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "id")
	if !ok {
		return
	}
	var in struct {
		Title  *string `json:"title"`
		Pinned *bool   `json:"pinned"`
	}
	if err := readJSON(r, &in); err != nil {
		fail(w, http.StatusUnprocessableEntity, "invalid JSON body")
		return
	}
	changed, err := s.Chats.Update(id, in.Title, in.Pinned)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !changed {
		fail(w, http.StatusNotFound, "nothing to update")
		return
	}
	writeJSON(w, http.StatusOK, api.OK{OK: true})
}

func (s *Server) removeChat(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "id")
	if !ok {
		return
	}
	gone, err := s.Chats.Delete(id)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !gone {
		fail(w, http.StatusNotFound, "no such conversation")
		return
	}
	writeJSON(w, http.StatusOK, api.OK{OK: true})
}

// readBlob serves one stored image, cached for a year: the name is the
// SHA-256 of the contents, so a given URL can never answer differently.
func (s *Server) readBlob(w http.ResponseWriter, r *http.Request) {
	path, media := s.Blobs.Resolve("blob:" + r.PathValue("digest"))
	if path == "" {
		fail(w, http.StatusNotFound, "沒有這個檔案")
		return
	}
	w.Header().Set("Content-Type", media)
	serveFile(w, r, path, immutable)
}

func searchError(w http.ResponseWriter, err error, status int) {
	var un *search.Unavailable
	if errors.As(err, &un) {
		fail(w, status, un.Msg)
		return
	}
	fail(w, status, err.Error())
}

// The web routes take require_owner for the same reason the filesystem
// does: an API key that also turns this machine into a fetcher of
// arbitrary URLs hands out more than whoever minted it intended.
func (s *Server) webSearch(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	limit, ok := queryInt(w, r, "limit", 8)
	if !ok {
		return
	}
	out, err := s.Search.Search(r.Context(), r.URL.Query().Get("q"), limit)
	if err != nil {
		searchError(w, err, http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) webRead(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	out, err := s.Search.Read(r.Context(), r.URL.Query().Get("url"), r.URL.Query().Get("query"))
	if err != nil {
		searchError(w, err, http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) webAvailable(w http.ResponseWriter, r *http.Request) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return
	}
	writeJSON(w, http.StatusOK, api.Available{Available: s.Search.Available(r.Context())})
}

var _ = json.Marshal
