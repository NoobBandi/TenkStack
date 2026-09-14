package httpapi

import (
	"net/http"
	"unicode/utf8"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
)

func (s *Server) listUsers(w http.ResponseWriter, _ *http.Request) {
	rows, err := s.Users.List()
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
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
	user, err := s.Users.Create(in.Username, in.Password, in.DisplayName, in.Role)
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, user)
}

func (s *Server) deleteUser(w http.ResponseWriter, r *http.Request) {
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

func (s *Server) setPassword(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "id")
	if !ok {
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

func (s *Server) listAPIKeys(w http.ResponseWriter, _ *http.Request) {
	keys, err := s.Users.ListAPIKeys()
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, keys)
}

func (s *Server) createAPIKey(w http.ResponseWriter, r *http.Request) {
	var in struct {
		UserID *int64 `json:"user_id"`
		Name   string `json:"name"`
	}
	if err := readJSON(r, &in); err != nil || in.UserID == nil {
		fail(w, http.StatusBadRequest, "user_id is required")
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
