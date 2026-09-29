// Package auth resolves the caller: an HMAC-signed session cookie for browsers,
// an API key for everything else. Sessions are stateless so a restart does not
// log anyone out; the signing key is persisted for the same reason.
package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/NoobBandi/TenkStack/internal/api"
)

const (
	CookieName = "ai_console_session"
	SessionTTL = 30 * 24 * time.Hour
)

// Login must be open or nobody could authenticate; health is what a proxy
// probes before any user exists.
var publicPaths = map[string]bool{
	"/api/auth/login": true,
	"/api/health":     true,
}

// Accounts is what auth needs from the user store.
type Accounts interface {
	VerifyAPIKey(secret string) (*api.Identity, error)
	Any() (bool, error)
	// Role is a user's role now; ok is false once the user is gone.
	Role(id int64) (role string, ok bool, err error)
}

type Auth struct {
	keyPath  string
	accounts Accounts

	mu     sync.Mutex
	secret []byte
}

func New(keyPath string, accounts Accounts) *Auth {
	return &Auth{keyPath: keyPath, accounts: accounts}
}

func (a *Auth) key() ([]byte, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.secret != nil {
		return a.secret, nil
	}
	b, err := os.ReadFile(a.keyPath)
	if err == nil {
		a.secret = b
		return b, nil
	}
	if !os.IsNotExist(err) {
		return nil, err
	}
	b = make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(a.keyPath), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(a.keyPath, b, 0o600); err != nil {
		return nil, err
	}
	log.Printf("generated a new session signing key at %s", a.keyPath)
	a.secret = b
	return b, nil
}

type claims struct {
	UID      int64  `json:"uid"`
	Username string `json:"username"`
	Role     string `json:"role"`
	Exp      int64  `json:"exp"`
}

var b64 = base64.RawURLEncoding

func (a *Auth) Issue(u api.LoginUser) (string, error) {
	payload, err := json.Marshal(claims{
		UID: u.ID, Username: u.Username, Role: u.Role,
		Exp: time.Now().Add(SessionTTL).Unix(),
	})
	if err != nil {
		return "", err
	}
	secret, err := a.key()
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(payload)
	return b64.EncodeToString(payload) + "." + b64.EncodeToString(mac.Sum(nil)), nil
}

func (a *Auth) read(token string) *claims {
	encPayload, encSig, ok := strings.Cut(token, ".")
	if !ok {
		return nil
	}
	payload, err := b64.DecodeString(encPayload)
	if err != nil {
		return nil
	}
	sig, err := b64.DecodeString(encSig)
	if err != nil {
		return nil
	}
	secret, err := a.key()
	if err != nil {
		return nil
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(payload)
	if !hmac.Equal(mac.Sum(nil), sig) {
		return nil
	}
	var c claims
	if json.Unmarshal(payload, &c) != nil || c.Exp < time.Now().Unix() {
		return nil
	}
	return &c
}

// Identify resolves the caller from the session cookie or an API key.
func (a *Auth) Identify(r *http.Request) *api.Identity {
	if c, err := r.Cookie(CookieName); err == nil {
		if cl := a.read(c.Value); cl != nil {
			// The cookie says who signed in and lasts a month; what they
			// may do is read now, so deleting or demoting someone takes
			// effect on their next request rather than when it expires.
			role, ok, err := a.accounts.Role(cl.UID)
			if err != nil {
				log.Printf("could not read the role of user %d; refusing the session: %v", cl.UID, err)
				return nil
			}
			if !ok {
				return nil
			}
			return &api.Identity{UserID: cl.UID, Username: cl.Username, Role: role, Via: "session"}
		}
	}
	key := ""
	if h := r.Header.Get("Authorization"); len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		key = strings.TrimSpace(h[7:])
	}
	if key == "" {
		key = r.Header.Get("X-Api-Key")
	}
	if key == "" {
		return nil
	}
	id, err := a.accounts.VerifyAPIKey(key)
	if err != nil {
		log.Printf("api key lookup failed: %v", err)
		return nil
	}
	return id
}

// Enforced is true once any account exists. The first run is open so the
// owner can create one; a broken store fails closed.
func (a *Auth) Enforced() bool {
	any, err := a.accounts.Any()
	if err != nil {
		log.Printf("could not read the user store; failing closed: %v", err)
		return true
	}
	return any
}

type ctxKey struct{}

// Identity is the caller the middleware resolved, or nil.
func Identity(ctx context.Context) *api.Identity {
	id, _ := ctx.Value(ctxKey{}).(*api.Identity)
	return id
}

// Middleware gates /api and /v1. Static assets stay open so the login page
// can load.
func (a *Auth) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		guarded := strings.HasPrefix(path, "/api/") || strings.HasPrefix(path, "/v1/")
		var id *api.Identity
		if guarded {
			id = a.Identify(r)
			if id == nil && !publicPaths[path] && a.Enforced() {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				json.NewEncoder(w).Encode(api.Error{Detail: "authentication required"})
				return
			}
			// A key is pasted into a chat client and travels. It opens the
			// model API and nothing of the console's own: not accounts,
			// not models, not the files.
			if id != nil && id.Via == "api-key" && strings.HasPrefix(path, "/api/") {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusForbidden)
				json.NewEncoder(w).Encode(api.Error{Detail: "API 金鑰只能用在 /v1 的模型 API，主控台的功能要登入後使用"})
				return
			}
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, id)))
	})
}

type Denied struct {
	Status int
	Detail string
}

func (d *Denied) Error() string { return d.Detail }

// RequireOwner admits a logged-in administrator in a browser and nothing
// else: API keys travel, and must not open the filesystem routes. Returns
// nil, nil while enforcement is off.
func (a *Auth) RequireOwner(r *http.Request) (*api.Identity, *Denied) {
	if !a.Enforced() {
		return nil, nil
	}
	id := Identity(r.Context())
	if id == nil {
		id = a.Identify(r)
	}
	switch {
	case id == nil:
		return nil, &Denied{http.StatusUnauthorized, "請先登入"}
	case id.Via != "session":
		return nil, &Denied{http.StatusForbidden, "這個功能只接受登入後的瀏覽器工作階段，不接受 API 金鑰"}
	case id.Role != "admin":
		return nil, &Denied{http.StatusForbidden, "這個功能限管理員使用"}
	}
	return id, nil
}
