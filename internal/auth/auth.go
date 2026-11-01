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
	"encoding/hex"
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
	// SetupCookie carries the setup token once a setup link was opened.
	SetupCookie = "tenkstack_setup"
	// SetupHeader carries it for a program, such as `tenkstack provision`.
	SetupHeader = "X-Setup-Token"
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
	// setupPath holds the setup token, beside the signing key.
	setupPath string

	mu      sync.Mutex
	secret  []byte
	setup   string
	retired bool
}

func New(keyPath string, accounts Accounts) *Auth {
	return &Auth{keyPath: keyPath, accounts: accounts, setupPath: filepath.Join(filepath.Dir(keyPath), "setup-token")}
}

// SetupToken is what admits a caller before the first account exists. Until
// then there is nobody to sign in as, and whoever reaches the console first
// would otherwise make themselves its administrator -- on an install that
// listens on every interface, that could be anyone on the network. The
// token is in a file only this machine's user can read; the installer
// prints a link carrying it, and the console logs one.
func (a *Auth) SetupToken() (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.setup != "" {
		return a.setup, nil
	}
	a.retired = false
	if b, err := os.ReadFile(a.setupPath); err == nil && len(strings.TrimSpace(string(b))) >= 32 {
		a.setup = strings.TrimSpace(string(b))
		return a.setup, nil
	}
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	token := hex.EncodeToString(b)
	if err := os.MkdirAll(filepath.Dir(a.setupPath), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(a.setupPath, []byte(token+"\n"), 0o600); err != nil {
		return "", err
	}
	log.Printf("no account exists yet: open the console with ?setup=%s to create the first one (the token is also in %s)", token, a.setupPath)
	a.setup = token
	return token, nil
}

// setupAdmits is whether r carries the setup token.
func (a *Auth) setupAdmits(r *http.Request) bool {
	given := r.Header.Get(SetupHeader)
	if given == "" {
		if c, err := r.Cookie(SetupCookie); err == nil {
			given = c.Value
		}
	}
	if given == "" {
		return false
	}
	token, err := a.SetupToken()
	if err != nil {
		log.Printf("could not read the setup token; refusing: %v", err)
		return false
	}
	return hmac.Equal([]byte(given), []byte(token))
}

// retireSetup removes the token once an account exists: from then on the
// accounts are how anyone gets in.
func (a *Auth) retireSetup() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.retired {
		return
	}
	a.setup, a.retired = "", true
	if err := os.Remove(a.setupPath); err != nil && !os.IsNotExist(err) {
		log.Printf("could not remove the setup token: %v", err)
	}
}

// AcceptSetupLink turns a link carrying ?setup= into a cookie and sends
// the browser on without the token in its address bar or history. It
// reports whether it answered the request.
func (a *Auth) AcceptSetupLink(w http.ResponseWriter, r *http.Request) bool {
	q := r.URL.Query()
	given := q.Get("setup")
	if given == "" {
		return false
	}
	q.Del("setup")
	next := *r.URL
	next.RawQuery = q.Encode()
	if !a.Enforced() {
		if token, err := a.SetupToken(); err == nil && hmac.Equal([]byte(given), []byte(token)) {
			proto, _, _ := strings.Cut(r.Header.Get("X-Forwarded-Proto"), ",")
			http.SetCookie(w, &http.Cookie{
				Name: SetupCookie, Value: given, Path: "/", MaxAge: int((24 * time.Hour).Seconds()),
				HttpOnly: true, SameSite: http.SameSiteLaxMode,
				Secure: strings.EqualFold(strings.TrimSpace(proto), "https"),
			})
		}
	}
	http.Redirect(w, r, next.RequestURI(), http.StatusFound)
	return true
}

func (a *Auth) key() ([]byte, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.secret != nil {
		return a.secret, nil
	}
	b, err := os.ReadFile(a.keyPath)
	switch {
	case err == nil && len(b) >= 32:
		a.secret = b
		return b, nil
	case err == nil:
		// An empty or truncated key would let anyone sign a session. Every
		// session it signed ends here, which is the point.
		log.Printf("the session signing key at %s is too short; replacing it", a.keyPath)
	case !os.IsNotExist(err):
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

// Enforced is true once any account exists. Before that, a caller with
// the setup token may do anything, so the owner can create one; a broken
// store fails closed.
func (a *Auth) Enforced() bool {
	any, err := a.accounts.Any()
	if err != nil {
		log.Printf("could not read the user store; failing closed: %v", err)
		return true
	}
	if any {
		a.retireSetup()
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
			if id == nil && !publicPaths[path] {
				if a.Enforced() {
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusUnauthorized)
					json.NewEncoder(w).Encode(api.Error{Detail: "authentication required"})
					return
				}
				if !a.setupAdmits(r) {
					// Setup tells the page to explain where the link is,
					// rather than offer a sign-in nobody can pass.
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusUnauthorized)
					json.NewEncoder(w).Encode(map[string]any{
						"detail": "還沒有任何帳號。請用安裝程式最後印出的網址開啟主控台（網址裡帶有 setup token），建立第一個帳號。",
						"setup":  true,
					})
					return
				}
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
