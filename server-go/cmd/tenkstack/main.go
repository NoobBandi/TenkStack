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
	"path/filepath"
	"syscall"
	"time"

	"github.com/NoobBandi/TenkStack/server-go/internal/activity"
	"github.com/NoobBandi/TenkStack/server-go/internal/auth"
	"github.com/NoobBandi/TenkStack/server-go/internal/backends"
	"github.com/NoobBandi/TenkStack/server-go/internal/blobs"
	"github.com/NoobBandi/TenkStack/server-go/internal/catalog"
	"github.com/NoobBandi/TenkStack/server-go/internal/channels"
	"github.com/NoobBandi/TenkStack/server-go/internal/chats"
	"github.com/NoobBandi/TenkStack/server-go/internal/comfy"
	"github.com/NoobBandi/TenkStack/server-go/internal/containerhistory"
	"github.com/NoobBandi/TenkStack/server-go/internal/containers"
	"github.com/NoobBandi/TenkStack/server-go/internal/files"
	"github.com/NoobBandi/TenkStack/server-go/internal/flags"
	"github.com/NoobBandi/TenkStack/server-go/internal/gguf"
	"github.com/NoobBandi/TenkStack/server-go/internal/gpu"
	"github.com/NoobBandi/TenkStack/server-go/internal/gpu/amd"
	"github.com/NoobBandi/TenkStack/server-go/internal/gpu/intel"
	"github.com/NoobBandi/TenkStack/server-go/internal/gpu/nvidia"
	"github.com/NoobBandi/TenkStack/server-go/internal/gpuhistory"
	"github.com/NoobBandi/TenkStack/server-go/internal/httpapi"
	"github.com/NoobBandi/TenkStack/server-go/internal/journal"
	"github.com/NoobBandi/TenkStack/server-go/internal/llamaswap"
	"github.com/NoobBandi/TenkStack/server-go/internal/network"
	"github.com/NoobBandi/TenkStack/server-go/internal/paths"
	"github.com/NoobBandi/TenkStack/server-go/internal/ports"
	"github.com/NoobBandi/TenkStack/server-go/internal/quant"
	"github.com/NoobBandi/TenkStack/server-go/internal/release"
	"github.com/NoobBandi/TenkStack/server-go/internal/search"
	"github.com/NoobBandi/TenkStack/server-go/internal/settings"
	"github.com/NoobBandi/TenkStack/server-go/internal/store"
	"github.com/NoobBandi/TenkStack/server-go/internal/system"
	"github.com/NoobBandi/TenkStack/server-go/internal/users"
	"github.com/NoobBandi/TenkStack/server-go/internal/vendors"
	"github.com/NoobBandi/TenkStack/server-go/internal/visioncache"
	"github.com/NoobBandi/TenkStack/server-go/internal/webdist"
)

// Set at build time: -ldflags "-X main.version=1.2.3".
var version = "dev"

func main() {
	listen := flag.String("listen", envOr("CONSOLE_LISTEN", "127.0.0.1:8071"), "address to serve on")
	webDist := flag.String("web", os.Getenv("CONSOLE_WEB_DIST"), "serve the frontend from this directory instead of the embedded copy")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}

	layout := paths.FromEnv()
	home, _ := os.UserHomeDir()
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

	config := llamaswap.NewStore(layout.LlamaSwapConfig)
	models := &llamaswap.Models{Store: config, Dir: layout.ModelsDir,
		Prefs: filepath.Join(layout.StateDir, "model-locations.json"),
		Avoid: []string{layout.ComfyDir, layout.StateDir}}
	probe := backends.New(config)
	llamaSwapBase := fmt.Sprintf("http://127.0.0.1:%d", portTable.LlamaSwap)

	blobStore := blobs.New(filepath.Join(layout.StateDir, "blobs"))
	chatStore := chats.New(db, blobStore)
	if err := chatStore.Init(); err != nil {
		log.Fatalf("init chats: %v", err)
	}
	vision := visioncache.New(db, specExtra{models}, layout.LlamaSwapConfig, llamaSwapBase)
	if err := vision.Init(); err != nil {
		log.Fatalf("init vision cache: %v", err)
	}
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

	gateway := &channels.Channels{Dir: layout.CaddyDir, CaddyBin: layout.CaddyBin, APIPort: portTable.API,
		ComfyBase: portTable.ComfyFirst, PublicBase: portTable.ComfyPublicFirst}

	srv := &httpapi.Server{
		Auth:       authn,
		Users:      userStore,
		Gpu:        cards,
		History:    history,
		Settings:   prefs,
		System:     system.New(layout.ModelsDir),
		Journal:    logs,
		LlamaSwap:  llamaswap.NewClient(llamaSwapBase),
		Activity:   activity.New(layout.LlamaSwapActivity),
		Containers: containerStats,
		Config:     config,
		Models:     models,
		Backends:   probe,
		Docker:     docker,
		Flags:      flags.NewCache(),
		Layout:     layout,
		Ports:      portTable,
		Channels:   gateway,
		ComfyProbe: comfy.NewProbe(portTable.ComfyPorts(), portTable.ComfyPublicFirst-portTable.ComfyFirst,
			network.PortOpen, docker),
		Comfy:   comfy.NewManager(docker, gateway, portTable.ComfyPorts(), layout.ComfyDir, containers.BusKey),
		Chats:   chatStore,
		Blobs:   blobStore,
		Vision:  vision,
		Search:  search.New(envOr("CONSOLE_SEARXNG_URL", "http://127.0.0.1:8090")),
		Catalog: catalog.New(models),
		Files: &files.Files{ComfyDir: layout.ComfyDir, StateDir: layout.StateDir, Home: home,
			Roots: os.Getenv("CONSOLE_FILE_ROOTS"), ExtraDeny: os.Getenv("CONSOLE_FILE_DENY")},
		Remote: gguf.NewRemote(),
		// TENKSTACK_REPO and TENKSTACK_RELEASE_API exist for a fork and for
		// testing against a stand-in; an ordinary install sets neither.
		Release: release.New(os.Getenv("TENKSTACK_REPO"), os.Getenv("TENKSTACK_RELEASE_API"), version,
			[]string{"tenkstack-console.service", "ai-console.service"}),
		Installer: &backends.Installer{Probe: probe, Config: config, Images: docker,
			ScriptDir: filepath.Dir(layout.LlamaSwapConfig), ModelsDir: layout.ModelsDir},
		Quant: quant.New(docker, models, filepath.Join(layout.StateDir, "quant"),
			func(ctx context.Context) []vendors.Card {
				var out []vendors.Card
				for _, d := range cards.Discover(ctx) {
					address := ""
					if d.PCIBDFAddress != nil {
						address = *d.PCIBDFAddress
					}
					out = append(out, vendors.Card{PCIBDFAddress: address, Name: d.Name, Vendor: d.Vendor})
				}
				return out
			}),
		Version:    version,
		WebDist:    *webDist,
		Embedded:   webdist.FS(),
		Started:    time.Now(),
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
	// Existing instances get the pre-start hook and the Manager flag too,
	// not only ones made from now on; nothing to do on a machine that has
	// never had ComfyUI.
	if _, err := os.Stat(filepath.Join(layout.ComfyDir, "storage-user")); err == nil {
		srv.Comfy.Seed()
	}
	srv.Files.ModelRoots = func() []files.ModelRoot {
		var out []files.ModelRoot
		labels := map[string]string{}
		for _, row := range models.ListLocationLabels() {
			labels[row[0]] = row[1]
		}
		for _, loc := range models.Locations() {
			out = append(out, files.ModelRoot{Key: loc.Key, Label: labels[loc.Key], Path: loc.Path,
				Primary: loc.Key == llamaswap.PrimaryLocation})
		}
		return out
	}
	// Container launchers mount every model location from a list beside
	// them; it is rewritten here in case config.yaml was edited by hand.
	if err := models.WriteMountList(); err != nil {
		log.Printf("could not write the model location list: %v", err)
	}
	if changed, err := backends.UpgradeMounts(filepath.Dir(layout.LlamaSwapConfig)); err != nil {
		log.Printf("could not upgrade the launchers to mount every model location: %v", err)
	} else {
		for _, path := range changed {
			log.Printf("launcher %s now mounts every model location", filepath.Base(path))
		}
	}
	// What the root ComfyUI container writes is taken back for the files
	// page when the owner is all that stops a delete or a rename.
	srv.Files.Reclaim = func(dir string) error {
		rctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		defer cancel()
		return srv.Comfy.Reclaim(rctx, dir)
	}
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

	switch {
	case *webDist != "":
		log.Printf("frontend from %s", *webDist)
	case srv.Embedded == nil:
		log.Print("no frontend embedded and CONSOLE_WEB_DIST unset; /api works, the page will not")
	}
	log.Printf("tenkstack %s listening on %s", version, *listen)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// specExtra hands the vision cache a model's extra flags.
type specExtra struct{ models *llamaswap.Models }

func (s specExtra) ExtraOf(modelID string) (string, bool) {
	spec := s.models.ReadSpec(modelID)
	if spec == nil {
		return "", false
	}
	return spec.Extra, true
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
