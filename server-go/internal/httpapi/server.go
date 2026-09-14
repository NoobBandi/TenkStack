// Package httpapi is the HTTP surface. Handlers decode, call a domain package,
// and encode; nothing here touches the database or the filesystem directly,
// except the static file handlers in static.go.
package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"sync"

	"github.com/NoobBandi/TenkStack/server-go/internal/activity"
	"github.com/NoobBandi/TenkStack/server-go/internal/api"
	"github.com/NoobBandi/TenkStack/server-go/internal/auth"
	"github.com/NoobBandi/TenkStack/server-go/internal/backends"
	"github.com/NoobBandi/TenkStack/server-go/internal/blobs"
	"github.com/NoobBandi/TenkStack/server-go/internal/catalog"
	"github.com/NoobBandi/TenkStack/server-go/internal/channels"
	"github.com/NoobBandi/TenkStack/server-go/internal/chats"
	"github.com/NoobBandi/TenkStack/server-go/internal/comfy"
	"github.com/NoobBandi/TenkStack/server-go/internal/containerhistory"
	"github.com/NoobBandi/TenkStack/server-go/internal/containers"
	"github.com/NoobBandi/TenkStack/server-go/internal/flags"
	"github.com/NoobBandi/TenkStack/server-go/internal/gguf"
	"github.com/NoobBandi/TenkStack/server-go/internal/gpu"
	"github.com/NoobBandi/TenkStack/server-go/internal/gpuhistory"
	"github.com/NoobBandi/TenkStack/server-go/internal/journal"
	"github.com/NoobBandi/TenkStack/server-go/internal/llamaswap"
	"github.com/NoobBandi/TenkStack/server-go/internal/paths"
	"github.com/NoobBandi/TenkStack/server-go/internal/ports"
	"github.com/NoobBandi/TenkStack/server-go/internal/search"
	"github.com/NoobBandi/TenkStack/server-go/internal/settings"
	"github.com/NoobBandi/TenkStack/server-go/internal/system"
	"github.com/NoobBandi/TenkStack/server-go/internal/users"
	"github.com/NoobBandi/TenkStack/server-go/internal/visioncache"
)

type Server struct {
	Auth       *auth.Auth
	Users      *users.Store
	Gpu        *gpu.Registry
	History    *gpuhistory.History
	Settings   *settings.Store
	System     *system.Sampler
	Journal    *journal.Journal
	LlamaSwap  *llamaswap.Client
	Activity   *activity.Store
	Containers *containerhistory.History
	Config     *llamaswap.Store
	Models     *llamaswap.Models
	Backends   *backends.Probe
	Docker     *containers.Docker
	Flags      *flags.Cache
	Layout     paths.Layout
	Ports      ports.Ports
	Channels   *channels.Channels
	ComfyProbe *comfy.Probe
	Comfy      *comfy.Manager
	Installer  *backends.Installer
	Chats      *chats.Store
	Blobs      *blobs.Store
	Vision     *visioncache.Cache
	Search     *search.Client
	Catalog    *catalog.Catalog
	Remote     *gguf.Remote
	// One eviction at a time: two requests arriving together would both
	// decide to clear the card and both wait for it.
	vramMu  sync.Mutex
	Version string
	WebDist string
	// DevOrigins get CORS headers with credentials, for the Vite dev server.
	DevOrigins []string
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, api.OK{OK: true})
	})
	mux.HandleFunc("GET /api/version", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, api.Version{Version: s.Version})
	})

	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.HandleFunc("POST /api/auth/logout", s.logout)
	mux.HandleFunc("GET /api/auth/me", s.whoami)

	mux.HandleFunc("GET /api/users", s.listUsers)
	mux.HandleFunc("POST /api/users", s.createUser)
	mux.HandleFunc("DELETE /api/users/{id}", s.deleteUser)
	mux.HandleFunc("POST /api/users/{id}/password", s.setPassword)
	mux.HandleFunc("GET /api/api-keys", s.listAPIKeys)
	mux.HandleFunc("POST /api/api-keys", s.createAPIKey)
	mux.HandleFunc("DELETE /api/api-keys/{id}", s.deleteAPIKey)

	mux.HandleFunc("GET /api/gpu", s.readGpu)
	mux.HandleFunc("GET /api/gpu/history", s.readGpuHistory)
	mux.HandleFunc("GET /api/gpu/devices", s.readGpuDevices)

	mux.HandleFunc("GET /api/stream", s.stream)
	mux.HandleFunc("GET /api/logs", s.readLogs)
	mux.HandleFunc("GET /api/activity", s.readActivity)
	mux.HandleFunc("GET /api/models/last-used", s.readLastUsed)
	mux.HandleFunc("GET /api/containers/history", s.readContainerHistory)

	mux.HandleFunc("GET /api/models", s.readModels)
	mux.HandleFunc("POST /api/models", s.createModel)
	mux.HandleFunc("GET /api/models/files", s.readModelFiles)
	mux.HandleFunc("GET /api/models/recommended", s.readRecommended)
	mux.HandleFunc("POST /api/models/unload", s.unloadAll)
	mux.HandleFunc("GET /api/models/{id}/spec", s.readModelSpec)
	mux.HandleFunc("POST /api/models/{id}/unload", s.unloadOne)
	mux.HandleFunc("GET /api/models/{id}/files", s.modelFiles)
	mux.HandleFunc("DELETE /api/models/{id}", s.removeModel)
	mux.HandleFunc("GET /api/files/partials", s.readPartials)
	mux.HandleFunc("DELETE /api/files/partials/{filename...}", s.removePartial)
	mux.HandleFunc("DELETE /api/files/{filename...}", s.removeFile)

	mux.HandleFunc("GET /api/catalog/search", s.catalogSearch)
	mux.HandleFunc("GET /api/catalog/files", s.catalogFiles)
	mux.HandleFunc("POST /api/catalog/estimate", s.catalogEstimate)
	mux.HandleFunc("POST /api/catalog/download", s.catalogDownload)
	mux.HandleFunc("POST /api/catalog/cancel", s.catalogCancel)
	mux.HandleFunc("GET /api/catalog/downloads", s.catalogDownloads)

	mux.HandleFunc("GET /api/chats", s.listChats)
	mux.HandleFunc("POST /api/chats", s.saveChat)
	mux.HandleFunc("GET /api/chats/{id}", s.readChat)
	mux.HandleFunc("PATCH /api/chats/{id}", s.patchChat)
	mux.HandleFunc("DELETE /api/chats/{id}", s.removeChat)
	mux.HandleFunc("GET /api/blobs/{digest}", s.readBlob)
	mux.HandleFunc("GET /api/search", s.webSearch)
	mux.HandleFunc("GET /api/search/read", s.webRead)
	mux.HandleFunc("GET /api/search/available", s.webAvailable)
	mux.HandleFunc("GET /v1/{path...}", s.proxyV1)
	mux.HandleFunc("POST /v1/{path...}", s.proxyV1)
	mux.HandleFunc("OPTIONS /v1/{path...}", s.proxyV1)

	mux.HandleFunc("POST /api/models/{id}/load", s.loadModel)
	mux.HandleFunc("GET /api/comfyui/instances", s.readComfyInstances)
	mux.HandleFunc("POST /api/comfyui/update/check", s.comfyUpdateCheck)
	mux.HandleFunc("POST /api/comfyui/update", s.comfyUpdate)
	mux.HandleFunc("GET /api/comfyui/config", s.comfyConfig)
	mux.HandleFunc("POST /api/comfyui/config", s.comfyReconfigure)
	mux.HandleFunc("POST /api/comfyui/restart", s.comfyRestart)
	mux.HandleFunc("POST /api/comfyui/interrupt", s.comfyInterrupt)
	mux.HandleFunc("GET /api/runtimes", s.readRuntimes)
	mux.HandleFunc("POST /api/runtimes/card", s.setCardRole)
	mux.HandleFunc("POST /api/runtimes/comfy", s.comfyAction)
	mux.HandleFunc("POST /api/runtimes/action", s.runtimeAction)

	mux.HandleFunc("GET /api/backends/devices", s.readBackendDevices)
	mux.HandleFunc("GET /api/runtime", s.readRuntime)
	mux.HandleFunc("POST /api/runtime/container", s.runtimeContainer)
	mux.HandleFunc("GET /api/flags/llama-server", s.readLlamaFlags)
	mux.HandleFunc("GET /api/flags/comfyui", s.readComfyFlags)
	mux.HandleFunc("GET /api/config", s.readConfig)
	mux.HandleFunc("PUT /api/config", s.writeConfig)

	mux.HandleFunc("GET /api/channels", s.readChannels)
	mux.HandleFunc("POST /api/channels/{name}", s.writeChannel)
	mux.HandleFunc("POST /api/channels/{name}/scopes", s.writeChannelScopes)
	mux.HandleFunc("GET /api/endpoints", s.readEndpoints)
	mux.HandleFunc("GET /api/network", s.readNetwork)
	mux.HandleFunc("GET /api/machine", s.readMachine)
	mux.HandleFunc("GET /api/versions", s.readVersions)

	mux.HandleFunc("GET /api/settings", s.readSettings)
	mux.HandleFunc("PUT /api/settings", s.writeSettings)
	mux.HandleFunc("GET /api/system", s.readSystem)

	mux.HandleFunc("GET /fonts/cjk.ttf", s.cjkFont)
	mux.Handle("GET /assets/", s.assets())
	mux.HandleFunc("GET /", s.spa)

	return s.cors(s.Auth.Middleware(mux))
}

func (s *Server) cors(next http.Handler) http.Handler {
	allowed := map[string]bool{}
	for _, o := range s.DevOrigins {
		allowed[o] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); allowed[origin] {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Access-Control-Allow-Credentials", "true")
			h.Set("Vary", "Origin")
			if r.Method == http.MethodOptions {
				h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS")
				h.Set("Access-Control-Allow-Headers", r.Header.Get("Access-Control-Request-Headers"))
				w.WriteHeader(http.StatusOK)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, detail string) {
	writeJSON(w, status, api.Error{Detail: detail})
}

func denied(w http.ResponseWriter, d *auth.Denied) {
	fail(w, d.Status, d.Detail)
}

const maxBody = 1 << 20

func readJSON(r *http.Request, v any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil {
		return err
	}
	if len(body) > maxBody {
		return errors.New("request body too large")
	}
	return json.Unmarshal(body, v)
}

// pathInt reads an integer path segment; a non-integer is 422, as FastAPI
// answers it.
func pathInt(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
	n, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	if err != nil {
		fail(w, http.StatusUnprocessableEntity, name+" must be an integer")
		return 0, false
	}
	return n, true
}
