// Command tenkstack is the console backend. This file only wires things
// together: open the store, build the services, mount the routes.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/NoobBandi/TenkStack/server-go/internal/auth"
	"github.com/NoobBandi/TenkStack/server-go/internal/httpapi"
	"github.com/NoobBandi/TenkStack/server-go/internal/paths"
	"github.com/NoobBandi/TenkStack/server-go/internal/store"
	"github.com/NoobBandi/TenkStack/server-go/internal/users"
)

// Set at build time: -ldflags "-X main.version=1.2.3".
var version = "dev"

func main() {
	listen := flag.String("listen", envOr("CONSOLE_LISTEN", "127.0.0.1:8071"), "address to serve on")
	webDist := flag.String("web", envOr("CONSOLE_WEB_DIST", "../web/dist"), "built frontend directory")
	flag.Parse()

	layout := paths.FromEnv()

	db, err := store.Open(layout.DB)
	if err != nil {
		log.Fatalf("open %s: %v", layout.DB, err)
	}
	defer db.Close()

	userStore := users.New(db)
	if err := userStore.Init(); err != nil {
		log.Fatalf("init users: %v", err)
	}
	authn := auth.New(layout.SessionKey, userStore)
	if !authn.Enforced() {
		log.Print("no accounts exist yet, so authentication is OFF. It switches on by itself as soon as the first user is created.")
	}

	srv := &httpapi.Server{
		Auth:       authn,
		Users:      userStore,
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
