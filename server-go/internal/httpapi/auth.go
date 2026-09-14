package httpapi

import (
	"net/http"
	"strings"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
	"github.com/NoobBandi/TenkStack/server-go/internal/auth"
)

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := readJSON(r, &in); err != nil {
		fail(w, http.StatusUnprocessableEntity, "invalid JSON body")
		return
	}
	user, err := s.Users.VerifyPassword(in.Username, in.Password)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if user == nil {
		fail(w, http.StatusUnauthorized, "帳號或密碼錯誤")
		return
	}
	token, err := s.Auth.Issue(*user)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Secure follows how the request reached the gateway, which Caddy reports
	// in X-Forwarded-Proto; the console itself only speaks loopback HTTP.
	proto, _, _ := strings.Cut(r.Header.Get("X-Forwarded-Proto"), ",")
	http.SetCookie(w, &http.Cookie{
		Name:     auth.CookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   int(auth.SessionTTL.Seconds()),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   strings.EqualFold(strings.TrimSpace(proto), "https"),
	})
	writeJSON(w, http.StatusOK, user)
}

func (s *Server) logout(w http.ResponseWriter, _ *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: auth.CookieName, Value: "", Path: "/", MaxAge: -1})
	writeJSON(w, http.StatusOK, api.OK{OK: true})
}

func (s *Server) whoami(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, api.Me{
		Identity:    auth.Identity(r.Context()),
		Enforcement: s.Auth.Enforced(),
	})
}
