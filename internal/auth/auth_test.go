package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/NoobBandi/TenkStack/internal/api"
)

type accounts struct{ any bool }

func (accounts) VerifyAPIKey(string) (*api.Identity, error) { return nil, nil }
func (a *accounts) Any() (bool, error)                      { return a.any, nil }
func (accounts) Role(int64) (string, bool, error)           { return "", false, nil }

func TestShortKeyIsReplaced(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.key")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if key, err := New(path, &accounts{}).key(); err != nil || len(key) < 32 {
		t.Fatalf("an empty key was used: %d bytes, %v", len(key), err)
	}
}

// Before the first account, only the setup token gets in; after it, the
// token is gone and accounts are the way in.
func TestSetupTokenGatesTheFirstAccount(t *testing.T) {
	dir := t.TempDir()
	store := &accounts{}
	a := New(filepath.Join(dir, "session.key"), store)
	token, err := a.SetupToken()
	if err != nil || len(token) < 32 {
		t.Fatalf("SetupToken = %q, %v", token, err)
	}
	if st, err := os.Stat(filepath.Join(dir, "setup-token")); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("token file: %v %v", st, err)
	}
	h := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) }))
	call := func(edit func(*http.Request)) (int, map[string]any) {
		r := httptest.NewRequest("POST", "/api/users", nil)
		edit(r)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, r)
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		return rec.Code, body
	}

	code, body := call(func(*http.Request) {})
	if code != 401 || body["setup"] != true {
		t.Errorf("no token: %d %v", code, body)
	}
	if code, _ := call(func(r *http.Request) { r.Header.Set(SetupHeader, "nope") }); code != 401 {
		t.Errorf("wrong token: %d", code)
	}
	if code, _ := call(func(r *http.Request) { r.Header.Set(SetupHeader, token) }); code != http.StatusTeapot {
		t.Errorf("token in a header: %d", code)
	}
	if code, _ := call(func(r *http.Request) { r.AddCookie(&http.Cookie{Name: SetupCookie, Value: token}) }); code != http.StatusTeapot {
		t.Errorf("token in a cookie: %d", code)
	}
	health := httptest.NewRecorder()
	h.ServeHTTP(health, httptest.NewRequest("GET", "/api/health", nil))
	if health.Code != http.StatusTeapot {
		t.Errorf("health is public: %d", health.Code)
	}

	store.any = true
	code, body = call(func(r *http.Request) { r.Header.Set(SetupHeader, token) })
	if code != 401 || body["setup"] != nil {
		t.Errorf("token after the first account: %d %v", code, body)
	}
	if _, err := os.Stat(filepath.Join(dir, "setup-token")); !os.IsNotExist(err) {
		t.Errorf("the token outlived the first account: %v", err)
	}
}

func TestSetupLinkBecomesACookie(t *testing.T) {
	a := New(filepath.Join(t.TempDir(), "session.key"), &accounts{})
	token, _ := a.SetupToken()

	rec := httptest.NewRecorder()
	if !a.AcceptSetupLink(rec, httptest.NewRequest("GET", "/?setup="+token+"&x=1", nil)) {
		t.Fatal("the link was not answered")
	}
	if loc := rec.Header().Get("Location"); strings.Contains(loc, token) || loc != "/?x=1" {
		t.Errorf("redirect keeps the token or loses the rest: %q", loc)
	}
	if c := rec.Header().Get("Set-Cookie"); !strings.Contains(c, SetupCookie+"="+token) || !strings.Contains(c, "HttpOnly") {
		t.Errorf("cookie: %q", c)
	}

	rec = httptest.NewRecorder()
	a.AcceptSetupLink(rec, httptest.NewRequest("GET", "/?setup=wrong", nil))
	if rec.Header().Get("Set-Cookie") != "" {
		t.Error("a wrong token was given a cookie")
	}
	if a.AcceptSetupLink(httptest.NewRecorder(), httptest.NewRequest("GET", "/chat", nil)) {
		t.Error("an ordinary page was answered")
	}
}
