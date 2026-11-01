package httpapi

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/NoobBandi/TenkStack/internal/api"
	"github.com/NoobBandi/TenkStack/internal/auth"
)

// Each password check is a scrypt derivation, about 16 MiB and tens of
// milliseconds, and the login page answers anyone. loginSlots bounds how
// many run at once; loginFailures bounds how many guesses one address gets.
var (
	loginSlots    = make(chan struct{}, 4)
	loginFailures = &failures{window: 15 * time.Minute, limit: 10, seen: map[string][]time.Time{}}
)

type failures struct {
	mu     sync.Mutex
	window time.Duration
	limit  int
	seen   map[string][]time.Time
}

// recent is the failures from key still inside the window.
func (f *failures) recent(key string, now time.Time) []time.Time {
	kept := f.seen[key][:0]
	for _, t := range f.seen[key] {
		if now.Sub(t) < f.window {
			kept = append(kept, t)
		}
	}
	if len(kept) == 0 {
		delete(f.seen, key)
		return nil
	}
	f.seen[key] = kept
	return kept
}

func (f *failures) blocked(key string, now time.Time) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.recent(key, now)) >= f.limit
}

func (f *failures) add(key string, now time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	// Guesses from many addresses must not grow the map without end.
	if len(f.seen) > 10000 {
		for k := range f.seen {
			f.recent(k, now)
		}
	}
	f.seen[key] = append(f.recent(key, now), now)
}

func (f *failures) clear(key string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.seen, key)
}

// clientAddress is who is asking. The console listens on loopback behind
// Caddy, which replaces any X-Forwarded-For a client sent with the address
// it saw; the last entry is Caddy's.
func clientAddress(r *http.Request) string {
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		parts := strings.Split(forwarded, ",")
		return strings.TrimSpace(parts[len(parts)-1])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := readJSON(r, &in); err != nil {
		fail(w, http.StatusUnprocessableEntity, "invalid JSON body")
		return
	}
	from := clientAddress(r)
	if loginFailures.blocked(from, time.Now()) {
		fail(w, http.StatusTooManyRequests, "密碼錯太多次了，請 15 分鐘後再試")
		return
	}
	select {
	case loginSlots <- struct{}{}:
	case <-r.Context().Done():
		return
	case <-time.After(10 * time.Second):
		fail(w, http.StatusServiceUnavailable, "登入的人太多，請稍後再試")
		return
	}
	user, err := s.Users.VerifyPassword(in.Username, in.Password)
	<-loginSlots
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if user == nil {
		loginFailures.add(from, time.Now())
		fail(w, http.StatusUnauthorized, "帳號或密碼錯誤")
		return
	}
	loginFailures.clear(from)
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
