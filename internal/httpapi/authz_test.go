package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/NoobBandi/TenkStack/internal/api"
	"github.com/NoobBandi/TenkStack/internal/auth"
	"github.com/NoobBandi/TenkStack/internal/store/storetest"
	"github.com/NoobBandi/TenkStack/internal/users"
)

// Who may do what, asked of the real routes: an administrator's session, a
// member's, a deleted member's, and API keys.
func TestAuthorization(t *testing.T) {
	dir := t.TempDir()
	accounts := users.New(storetest.New(t))
	admin, _ := accounts.Create("owner", "secret-1", "", "admin")
	member, _ := accounts.Create("dad", "secret-2", "", "member")
	authn := auth.New(filepath.Join(dir, "session.key"), accounts)
	srv := &Server{Auth: authn, Users: accounts}
	h := srv.Handler()

	session := func(u api.User) string {
		token, err := authn.Issue(api.LoginUser{ID: u.ID, Username: u.Username, Role: u.Role})
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	adminSession, memberSession := session(admin), session(member)
	adminKey, _ := accounts.CreateAPIKey(admin.ID, "pi")
	memberKey, _ := accounts.CreateAPIKey(member.ID, "pi")

	type as struct{ cookie, bearer string }
	call := func(who as, method, path string, body any) (int, []byte) {
		var buf bytes.Buffer
		if body != nil {
			json.NewEncoder(&buf).Encode(body)
		}
		req := httptest.NewRequest(method, path, &buf)
		req.Header.Set("Content-Type", "application/json")
		if who.cookie != "" {
			req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: who.cookie})
		}
		if who.bearer != "" {
			req.Header.Set("Authorization", "Bearer "+who.bearer)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code, rec.Body.Bytes()
	}
	asAdmin, asMember := as{cookie: adminSession}, as{cookie: memberSession}
	expect := func(name string, got, want int) {
		t.Helper()
		if got != want {
			t.Errorf("%s: %d, want %d", name, got, want)
		}
	}

	// A member cannot make anyone, least of all an administrator.
	code, _ := call(asMember, "POST", "/api/users", map[string]string{"username": "x", "password": "1234", "role": "admin"})
	expect("member creates an admin", code, 403)
	code, _ = call(asMember, "GET", "/api/users", nil)
	expect("member lists users", code, 403)
	code, _ = call(asMember, "DELETE", fmt.Sprintf("/api/users/%d", admin.ID), nil)
	expect("member deletes the admin", code, 403)
	code, _ = call(asAdmin, "POST", "/api/users", map[string]string{"username": "y", "password": "1234", "role": "superadmin"})
	expect("admin creates an unknown role", code, 422)

	// Passwords: one's own, or anyone's for the administrator.
	code, _ = call(asMember, "POST", fmt.Sprintf("/api/users/%d/password", admin.ID), map[string]string{"password": "hijack"})
	expect("member sets the admin's password", code, 403)
	code, _ = call(asMember, "POST", fmt.Sprintf("/api/users/%d/password", member.ID), map[string]string{"password": "new-2"})
	expect("member sets their own password", code, 200)

	// Keys: a member sees, makes and revokes their own only.
	code, body := call(asMember, "GET", "/api/api-keys", nil)
	var keys []api.APIKey
	json.Unmarshal(body, &keys)
	if code != 200 || len(keys) != 1 || keys[0].UserID != member.ID {
		t.Errorf("member lists keys: %d %s", code, body)
	}
	code, _ = call(asMember, "POST", "/api/api-keys", map[string]any{"user_id": admin.ID, "name": "x"})
	expect("member makes a key for the admin", code, 403)
	code, _ = call(asMember, "POST", "/api/api-keys", map[string]any{"name": "mine"})
	expect("member makes a key for themselves", code, 200)
	code, _ = call(asMember, "DELETE", fmt.Sprintf("/api/api-keys/%d", adminKey.ID), nil)
	expect("member revokes the admin's key", code, 404)
	code, _ = call(asMember, "DELETE", fmt.Sprintf("/api/api-keys/%d", memberKey.ID), nil)
	expect("member revokes their own key", code, 200)
	code, body = call(asAdmin, "GET", "/api/api-keys", nil)
	json.Unmarshal(body, &keys)
	if code != 200 || len(keys) != 2 {
		t.Errorf("admin lists every key: %d %s", code, body)
	}

	// What changes the machine for everyone is the administrator's.
	for _, c := range []struct{ method, path string }{
		{"POST", "/api/models"},
		{"DELETE", "/api/models/some-model"},
		{"DELETE", "/api/files/a/b.gguf"},
		{"DELETE", "/api/files/partials/a/b.gguf.part"},
		{"POST", "/api/catalog/download"},
		{"POST", "/api/catalog/cancel"},
		{"POST", "/api/channels/public"},
		{"POST", "/api/channels/public/scopes"},
		{"POST", "/api/comfyui/update"},
		{"POST", "/api/comfyui/restart"},
		{"POST", "/api/comfyui/version/check"},
		{"PUT", "/api/config"},
		{"PUT", "/api/settings"},
		// The Hugging Face token opens gated models on the owner's account.
		{"GET", "/api/settings/huggingface"},
		{"PUT", "/api/settings/huggingface"},
		{"DELETE", "/api/settings/huggingface"},
		{"GET", "/api/search/service"},
		{"POST", "/api/search/restart"},
		// A benchmark unloads other people's models and pauses /v1 (D29).
		{"GET", "/api/bench/plan?model=m&tier=quick"},
		{"POST", "/api/bench/run"},
		{"POST", "/api/bench/cancel"},
		{"GET", "/api/bench/runs"},
		{"GET", "/api/bench/runs/1"},
		{"GET", "/api/bench/runs/1/export"},
		{"DELETE", "/api/bench/runs/1"},
	} {
		code, _ := call(asMember, c.method, c.path, map[string]any{})
		expect("member "+c.method+" "+c.path, code, 403)
	}

	// Everyone signed in reads the benchmark's state, for the banner.
	code, _ = call(asMember, "GET", "/api/bench/status", nil)
	expect("member reads the benchmark status", code, 200)
	code, _ = call(as{}, "GET", "/api/bench/status", nil)
	expect("nobody reads the benchmark status", code, 401)

	// A key opens the model API only, whoever it belongs to.
	code, _ = call(as{bearer: adminKey.Secret}, "GET", "/api/api-keys", nil)
	expect("admin's key on /api", code, 403)
	code, _ = call(as{bearer: adminKey.Secret}, "POST", "/api/users", map[string]string{"username": "z", "password": "1234"})
	expect("admin's key creates a user", code, 403)

	// Deleting someone ends their session at once, not in thirty days.
	code, _ = call(asAdmin, "DELETE", fmt.Sprintf("/api/users/%d", member.ID), nil)
	expect("admin deletes the member", code, 200)
	code, _ = call(asMember, "GET", "/api/api-keys", nil)
	expect("deleted member's session", code, 401)
}
