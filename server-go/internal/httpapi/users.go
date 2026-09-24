package httpapi

import (
	"net/http"
	"unicode/utf8"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
)

func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	if !s.owner(w, r) {
		return
	}
	rows, err := s.Users.List()
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	if !s.owner(w, r) {
		return
	}
	var in struct {
		Username    string `json:"username"`
		Password    string `json:"password"`
		DisplayName string `json:"display_name"`
		Role        string `json:"role"`
	}
	if err := readJSON(r, &in); err != nil {
		fail(w, http.StatusUnprocessableEntity, "invalid JSON body")
		return
	}
	switch {
	case in.Username == "":
		fail(w, http.StatusUnprocessableEntity, "username is required")
		return
	case utf8.RuneCountInString(in.Password) < 4:
		fail(w, http.StatusUnprocessableEntity, "password must be at least 4 characters")
		return
	}
	if in.Role == "" {
		in.Role = "member"
	}
	if in.Role != "member" && in.Role != "admin" {
		fail(w, http.StatusUnprocessableEntity, "role must be member or admin")
		return
	}
	user, err := s.Users.Create(in.Username, in.Password, in.DisplayName, in.Role)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, user)
}

func (s *Server) deleteUser(w http.ResponseWriter, r *http.Request) {
	if !s.owner(w, r) {
		return
	}
	id, ok := pathInt(w, r, "id")
	if !ok {
		return
	}
	gone, err := s.Users.Delete(id)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !gone {
		fail(w, http.StatusNotFound, "no such user")
		return
	}
	writeJSON(w, http.StatusOK, api.OK{OK: true})
}

// setPassword is the administrator's for anyone, and everyone's for
// themselves.
func (s *Server) setPassword(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "id")
	if !ok {
		return
	}
	me, isOwner, ok := s.caller(w, r)
	if !ok {
		return
	}
	if !isOwner && id != me {
		fail(w, http.StatusForbidden, "只能改自己的密碼")
		return
	}
	var in struct {
		Password string `json:"password"`
	}
	if err := readJSON(r, &in); err != nil {
		fail(w, http.StatusUnprocessableEntity, "invalid JSON body")
		return
	}
	if utf8.RuneCountInString(in.Password) < 4 {
		fail(w, http.StatusBadRequest, "password too short")
		return
	}
	changed, err := s.Users.SetPassword(id, in.Password)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, api.OK{OK: changed})
}

// listAPIKeys is every key for the administrator and a member's own for
// them.
func (s *Server) listAPIKeys(w http.ResponseWriter, r *http.Request) {
	me, isOwner, ok := s.caller(w, r)
	if !ok {
		return
	}
	keys, err := s.Users.ListAPIKeys()
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !isOwner {
		mine := keys[:0]
		for _, k := range keys {
			if k.UserID == me {
				mine = append(mine, k)
			}
		}
		keys = mine
	}
	writeJSON(w, http.StatusOK, keys)
}

func (s *Server) createAPIKey(w http.ResponseWriter, r *http.Request) {
	var in struct {
		UserID *int64 `json:"user_id"`
		Name   string `json:"name"`
	}
	if err := readJSON(r, &in); err != nil {
		fail(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	me, isOwner, ok := s.caller(w, r)
	if !ok {
		return
	}
	// A member makes keys for themselves only; left out, it is the caller.
	if in.UserID == nil {
		if me == 0 {
			fail(w, http.StatusBadRequest, "user_id is required")
			return
		}
		in.UserID = &me
	}
	if !isOwner && *in.UserID != me {
		fail(w, http.StatusForbidden, "只能替自己建立金鑰")
		return
	}
	if in.Name == "" {
		in.Name = "key"
	}
	key, err := s.Users.CreateAPIKey(*in.UserID, in.Name)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, key)
}

func (s *Server) deleteAPIKey(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "id")
	if !ok {
		return
	}
	me, isOwner, ok := s.caller(w, r)
	if !ok {
		return
	}
	if !isOwner {
		owner, found, err := s.Users.APIKeyOwner(id)
		if err != nil {
			fail(w, http.StatusInternalServerError, err.Error())
			return
		}
		// Someone else's key is answered as if it did not exist: whether a
		// key number is in use is not a member's to learn.
		if !found || owner != me {
			fail(w, http.StatusNotFound, "no such key")
			return
		}
	}
	gone, err := s.Users.DeleteAPIKey(id)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !gone {
		fail(w, http.StatusNotFound, "no such key")
		return
	}
	writeJSON(w, http.StatusOK, api.OK{OK: true})
}
