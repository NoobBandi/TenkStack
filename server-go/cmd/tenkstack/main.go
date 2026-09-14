// Command tenkstack is the console backend. This file only wires things
// together: open the store, build the services, mount the routes.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/NoobBandi/TenkStack/server-go/internal/activity"
	"github.com/NoobBandi/TenkStack/server-go/internal/auth"
	"github.com/NoobBandi/TenkStack/server-go/internal/containerhistory"
	"github.com/NoobBandi/TenkStack/server-go/internal/containers"
	"github.com/NoobBandi/TenkStack/server-go/internal/gpu"
	"github.com/NoobBandi/TenkStack/server-go/internal/gpu/amd"
	"github.com/NoobBandi/TenkStack/server-go/internal/gpu/intel"
	"github.com/NoobBandi/TenkStack/server-go/internal/gpu/nvidia"
	"github.com/NoobBandi/TenkStack/server-go/internal/gpuhistory"
	"github.com/NoobBandi/TenkStack/server-go/internal/httpapi"
	"github.com/NoobBandi/TenkStack/server-go/internal/journal"
	"github.com/NoobBandi/TenkStack/server-go/internal/llamaswap"
	"github.com/NoobBandi/TenkStack/server-go/internal/paths"
	"github.com/NoobBandi/TenkStack/server-go/internal/ports"
	"github.com/NoobBandi/TenkStack/server-go/internal/settings"
	"github.com/NoobBandi/TenkStack/server-go/internal/store"
	"github.com/NoobBandi/TenkStack/server-go/internal/system"
	"github.com/NoobBandi/TenkStack/server-go/internal/users"
)

// Set at build time: -ldflags "-X main.version=1.2.3".
var version = "dev"

func main() {
	listen := flag.String("listen", envOr("CONSOLE_LISTEN", "127.0.0.1:8071"), "address to serve on")
	webDist := flag.String("web", envOr("CONSOLE_WEB_DIST", "../web/dist"), "built frontend directory")
	flag.Parse()

	layout := paths.FromEnv()
	portTable := ports.FromEnv()

	db, err := store.Open(layout.DB)
	if err != nil {
		log.Fatalf("open %s: %v", layout.DB, err)
	}
	defer db.Close()

	userStore := users.New(db)
	if err := userStore.Init(); err != nil {
		log.Fatalf("init users: %v", err)
	}
	prefs := settings.New(db)
	if err := prefs.Init(); err != nil {
		log.Fatalf("init settings: %v", err)
	}
	authn := auth.New(layout.SessionKey, userStore)
	if !authn.Enforced() {
		log.Print("no accounts exist yet, so authentication is OFF. It switches on by itself as soon as the first user is created.")
	}

	// Intel first, then alphabetical: the order decides the global device
	// numbering, and device 0 is the card llama-server runs on by default.
	cards := gpu.NewRegistry(intel.New(), amd.New(), nvidia.New())
	history := gpuhistory.New(cards)
	history.SetHours(int(prefs.Get("gpu_history_hours")))

	logs := journal.New()
	logs.SetCapacity(int(prefs.Get("log_lines")))
	docker := containers.New()
	containerStats := containerhistory.New(containerhistory.SourceFunc(func(ctx context.Context) map[string]containerhistory.Running {
		out := map[string]containerhistory.Running{}
		for name, r := range docker.RunningIDs(ctx) {
			out[name] = containerhistory.Running{ID: r.ID, Pid: r.Pid}
		}
		return out
	}))

	srv := &httpapi.Server{
		Auth:       authn,
		Users:      userStore,
		Gpu:        cards,
		History:    history,
		Settings:   prefs,
		System:     system.New(layout.ModelsDir),
		Journal:    logs,
		LlamaSwap:  llamaswap.NewClient(fmt.Sprintf("http://127.0.0.1:%d", portTable.LlamaSwap)),
		Activity:   activity.New(layout.LlamaSwapActivity),
		Containers: containerStats,
		Version:    version,
		WebDist:    *webDist,
		DevOrigins: []string{"http://127.0.0.1:5173", "http://localhost:5173"},
	}

	httpServer := &http.Server{
		Addr:              *listen,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	// Sampling starts with the process, not the first browser: the chart
	// should show the last hours on load rather than begin at zero.
	history.Start(ctx)
	defer history.Stop()
	containerStats.Start(ctx)
	defer containerStats.Stop()
	logs.Start(ctx)
	defer logs.Stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		httpServer.Shutdown(shutdownCtx)
	}()

	log.Printf("tenkstack %s listening on %s", version, *listen)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
