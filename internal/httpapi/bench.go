package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/NoobBandi/TenkStack/internal/api"
	"github.com/NoobBandi/TenkStack/internal/backends"
	"github.com/NoobBandi/TenkStack/internal/bench"
	"github.com/NoobBandi/TenkStack/internal/containers"
	"github.com/NoobBandi/TenkStack/internal/llamaswap"
	"github.com/NoobBandi/TenkStack/internal/schema"
	"github.com/NoobBandi/TenkStack/internal/vendors"
)

// The benchmark's endpoints (api/bench.go). Running one unloads models
// other people may be using and pauses /v1 for everyone, so everything but
// the status is the administrator's (D29); the status is what every signed-in
// page reads for the banner.

// benchGate is the /v1 pause, nil -- admitting everything -- when the
// benchmark is not wired in.
func (s *Server) benchGate() *bench.Gate {
	if s.Bench == nil {
		return nil
	}
	return s.Bench.Gate
}

// pausedV1 answers a /v1 request while a run holds the API (D27). The body
// carries the message both where the console's pages read it and where
// OpenAI clients do, so a terminal agent shows why rather than a bare 503.
func pausedV1(w http.ResponseWriter, resumeAt time.Time) {
	wait := time.Until(resumeAt)
	if wait < time.Minute {
		// Overrunning, or nearly done: a short wait, but not so short
		// that a client hammers the console every second (Q14).
		wait = time.Minute
	}
	when := time.Now().Add(wait).Local().Format("15:04")
	msg := fmt.Sprintf(api.BenchPausedMessage, when)
	w.Header().Set("Retry-After", fmt.Sprint(int(math.Ceil(wait.Seconds()))))
	writeJSON(w, http.StatusServiceUnavailable, map[string]any{
		"detail": msg,
		"error":  map[string]any{"message": msg, "type": "service_unavailable", "code": "benchmark_running"},
	})
}

// benchHolds refuses a manual load or unload while a run holds the models:
// the gate covers /v1, but these buttons would swap the model under test
// just the same. True when it has answered.
func (s *Server) benchHolds(w http.ResponseWriter) bool {
	paused, resumeAt := s.benchGate().Paused()
	if !paused {
		return false
	}
	fail(w, http.StatusConflict, "正在跑分，暫時不能載入或卸載模型，預計 "+resumeAt.Local().Format("15:04")+" 結束")
	return true
}

func benchError(w http.ResponseWriter, err error) {
	var e *bench.Error
	if errors.As(err, &e) {
		fail(w, e.Status, e.Msg)
		return
	}
	fail(w, http.StatusInternalServerError, err.Error())
}

// benchReady answers for a console that has no benchmark wired in.
func (s *Server) benchReady(w http.ResponseWriter) bool {
	if s.Bench == nil {
		fail(w, http.StatusServiceUnavailable, "跑分功能沒有啟用")
		return false
	}
	return true
}

// benchModel is the canonical id of a configured model, or a 404.
func (s *Server) benchModel(w http.ResponseWriter, id string) (string, bool) {
	if id == "" {
		fail(w, http.StatusUnprocessableEntity, "model is required")
		return "", false
	}
	id = s.Config.CanonicalModel(id)
	if s.Models.ReadSpec(id) == nil {
		fail(w, http.StatusNotFound, "沒有這個模型："+id)
		return "", false
	}
	return id, true
}

func (s *Server) readBenchPlan(w http.ResponseWriter, r *http.Request) {
	if !s.owner(w, r) || !s.benchReady(w) {
		return
	}
	model, ok := s.benchModel(w, r.URL.Query().Get("model"))
	if !ok {
		return
	}
	tier := r.URL.Query().Get("tier")
	if tier == "" {
		tier = api.BenchQuick
	}
	plan, err := s.Bench.Plan(r.Context(), model, tier)
	if err != nil {
		benchError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, plan)
}

func (s *Server) startBench(w http.ResponseWriter, r *http.Request) {
	if !s.owner(w, r) || !s.benchReady(w) {
		return
	}
	var in api.BenchRunRequest
	if err := readJSON(r, &in); err != nil {
		fail(w, http.StatusUnprocessableEntity, "invalid body")
		return
	}
	model, ok := s.benchModel(w, in.Model)
	if !ok {
		return
	}
	in.Model = model
	progress, err := s.Bench.Start(r.Context(), in)
	if err != nil {
		benchError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, progress)
}

// readBenchStatus is for everyone signed in: the chat page shows the
// banner and disables its input from it.
func (s *Server) readBenchStatus(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := s.caller(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, s.Bench.Status())
}

func (s *Server) cancelBench(w http.ResponseWriter, r *http.Request) {
	if !s.owner(w, r) || !s.benchReady(w) {
		return
	}
	writeJSON(w, http.StatusOK, s.Bench.Cancel())
}

// benchRuns is the saved runs, or a 503 when nothing keeps them.
func (s *Server) benchRuns(w http.ResponseWriter, r *http.Request) (*bench.Runs, bool) {
	if !s.owner(w, r) || !s.benchReady(w) {
		return nil, false
	}
	if s.Bench.Runs == nil {
		fail(w, http.StatusServiceUnavailable, "跑分紀錄沒有啟用")
		return nil, false
	}
	return s.Bench.Runs, true
}

func (s *Server) listBenchRuns(w http.ResponseWriter, r *http.Request) {
	runs, ok := s.benchRuns(w, r)
	if !ok {
		return
	}
	rows, err := runs.List(r.Context())
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

// benchRun is one saved run, or the response saying there is none.
func (s *Server) benchRun(w http.ResponseWriter, r *http.Request) (*api.BenchRun, bool) {
	runs, ok := s.benchRuns(w, r)
	if !ok {
		return nil, false
	}
	id, ok := pathInt(w, r, "id")
	if !ok {
		return nil, false
	}
	run, err := runs.Get(r.Context(), id)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return nil, false
	}
	if run == nil {
		fail(w, http.StatusNotFound, "沒有這筆跑分紀錄")
		return nil, false
	}
	return run, true
}

func (s *Server) readBenchRun(w http.ResponseWriter, r *http.Request) {
	if run, ok := s.benchRun(w, r); ok {
		writeJSON(w, http.StatusOK, run)
	}
}

// exportBenchRun is the submission as a file, with nothing local in it
// (§11.1): no command, no paths.
func (s *Server) exportBenchRun(w http.ResponseWriter, r *http.Request) {
	run, ok := s.benchRun(w, r)
	if !ok {
		return
	}
	body, err := json.MarshalIndent(bench.Export(run.Submission), "", "  ")
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	stamp := time.Unix(run.StartedAt, 0).Local().Format("20060102-1504")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="tenkstack-bench-%s-%s.json"`, fileSafe(run.Model), stamp))
	w.WriteHeader(http.StatusOK)
	w.Write(append(body, '\n'))
}

func (s *Server) deleteBenchRun(w http.ResponseWriter, r *http.Request) {
	runs, ok := s.benchRuns(w, r)
	if !ok {
		return
	}
	id, ok := pathInt(w, r, "id")
	if !ok {
		return
	}
	found, err := runs.Delete(r.Context(), id)
	if err != nil {
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if !found {
		fail(w, http.StatusNotFound, "沒有這筆跑分紀錄")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// fileSafe keeps a name to what any browser saves as given: ASCII letters,
// digits, dot, dash and underscore.
func fileSafe(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	if b.Len() == 0 {
		return "model"
	}
	return b.String()
}

// BenchHost is what the benchmark needs from the rest of the console:
// llama-swap's groups, whether ComfyUI is drawing on the model's cards, and
// the model's resource peaks from the samplers that already run.
type BenchHost struct{ S *Server }

// Groups reads config.yaml's groups with llama-swap's defaults.
func (h BenchHost) Groups(ctx context.Context) []bench.Group {
	c, err := h.S.Config.Load()
	if err != nil {
		return nil
	}
	groups := c.Root().Map("groups")
	if groups == nil {
		return nil
	}
	flag := func(m *llamaswap.Mapping, key string, def bool) bool {
		switch strings.ToLower(llamaswap.Scalar(m.Get(key))) {
		case "true":
			return true
		case "false":
			return false
		}
		return def
	}
	var out []bench.Group
	for _, name := range groups.Keys() {
		g := groups.Map(name)
		if g == nil {
			continue
		}
		out = append(out, bench.Group{Name: name, Swap: flag(g, "swap", true), Exclusive: flag(g, "exclusive", true),
			Persistent: flag(g, "persistent", false), Members: llamaswap.Strings(g.Get("members"))})
	}
	return out
}

// Names is each entry's display name, the id where it has none.
func (h BenchHost) Names(ctx context.Context) map[string]string {
	out := map[string]string{}
	c, err := h.S.Config.Load()
	if err != nil {
		return out
	}
	models := c.Root().Map("models")
	if models == nil {
		return out
	}
	for _, id := range models.Keys() {
		out[id] = id
		if entry := models.Map(id); entry != nil {
			if name := strings.TrimSpace(llamaswap.Scalar(entry.Get("name"))); name != "" {
				out[id] = name
			}
		}
	}
	return out
}

// benchCards is the cards a model's entry selects, by the same reading as
// the occupants view: its selector variable against each usable card's,
// and every card when it names none.
func (s *Server) benchCards(ctx context.Context, modelID string) []api.GpuDevice {
	if s.Gpu == nil {
		return nil
	}
	devices := s.Gpu.ListDevices(ctx)
	env := map[string]string{}
	if spec := s.Models.ReadSpec(modelID); spec != nil {
		env = spec.Env
	}
	templates := map[string][]string{}
	for _, sel := range vendors.BackendSelectors() {
		templates[sel.Variable] = append(templates[sel.Variable], sel.Template)
	}
	var usable []api.BackendDevice
	if s.Backends != nil {
		usable = backends.Match(s.Backends.Usable(ctx, false), devices)
	}
	var out []api.GpuDevice
	for _, d := range usable {
		if d.PCIBDFAddress == nil {
			continue
		}
		for variable, value := range d.Env {
			if selects(env[variable], value, templates[variable]) {
				for _, dev := range devices {
					if dev.PCIBDFAddress != nil && containers.BusKey(*dev.PCIBDFAddress) == containers.BusKey(*d.PCIBDFAddress) {
						out = append(out, dev)
					}
				}
				break
			}
		}
	}
	if len(out) == 0 {
		return devices
	}
	return out
}

// ComfyBusy is a ComfyUI instance with work running or queued on one of
// the model's cards.
func (h BenchHost) ComfyBusy(ctx context.Context, modelID string) bool {
	s := h.S
	if s.ComfyProbe == nil {
		return false
	}
	var busy []api.ComfyInstance
	for _, inst := range s.ComfyProbe.Instances(ctx) {
		if inst.QueueRunning > 0 || inst.QueuePending > 0 {
			busy = append(busy, inst)
		}
	}
	if len(busy) == 0 {
		return false
	}
	cards := s.benchCards(ctx, modelID)
	if len(cards) == 0 || s.Docker == nil {
		return true
	}
	byPort := s.Docker.PortCards(ctx, cardsOf(cards))
	for _, inst := range busy {
		for i := range cards {
			if sharesCard(inst, &cards[i], byPort) {
				return true
			}
		}
	}
	return false
}

// benchContainer is the container a model's entry runs in, from its
// cmdStop (docker stop NAME) or the NAME its launcher is given; empty for
// an engine that runs natively.
func (s *Server) benchContainer(modelID string) string {
	c, err := s.Config.Load()
	if err != nil {
		return ""
	}
	entry := c.Root().Map("models")
	if entry != nil {
		entry = entry.Map(modelID)
	}
	if entry == nil {
		return ""
	}
	if f := strings.Fields(llamaswap.Scalar(entry.Get("cmdStop"))); len(f) == 3 && f[0] == "docker" && f[1] == "stop" {
		return f[2]
	}
	for key, value := range llamaswap.EnvMap(entry.Get("env")) {
		if strings.HasSuffix(key, "_NAME") && value != "" {
			return value
		}
	}
	return ""
}

// rssEvery is how often a native engine's memory is read; the samplers
// that already run poll every 2 s too.
const rssEvery = 2 * time.Second

// Watch records a model's peaks from the samplers that already run: the
// GPU history per card, and the container history -- or, for an engine
// with no container, the resident memory of llama-swap's children, polled
// here because nothing else watches it.
func (h BenchHost) Watch(ctx context.Context, modelID string) func() schema.Resources {
	s := h.S
	from := time.Now()
	cards := s.benchCards(ctx, modelID)
	container := s.benchContainer(modelID)

	var mu sync.Mutex
	var rssPeak int64
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			if v := bench.DescendantRSS("llama-swap"); v > 0 {
				mu.Lock()
				rssPeak = max(rssPeak, v)
				mu.Unlock()
			}
			select {
			case <-stop:
				return
			case <-ctx.Done():
				return
			case <-time.After(rssEvery):
			}
		}
	}()

	return func() schema.Resources {
		close(stop)
		wg.Wait()
		start := float64(from.UnixNano()) / 1e9
		secs := int(time.Since(from).Seconds()) + 5
		out := schema.Resources{VRAMPeakMiB: []int{}}
		if s.History != nil {
			for _, card := range cards {
				peak := 0.0
				for _, p := range s.History.Points(card.Index, &secs, 0) {
					if p.T >= start && p.Vram != nil {
						peak = max(peak, *p.Vram)
					}
				}
				out.VRAMPeakMiB = append(out.VRAMPeakMiB, int(math.Round(peak)))
			}
		}
		var memPeak int64
		if container != "" && s.Containers != nil {
			for _, p := range s.Containers.Points(container, &secs, 0) {
				if p.T >= start {
					memPeak = max(memPeak, p.Memory)
				}
			}
		}
		if memPeak == 0 {
			mu.Lock()
			memPeak = rssPeak
			mu.Unlock()
		}
		out.RAMPeakMiB = int(memPeak >> 20)
		return out
	}
}
