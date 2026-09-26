package httpapi

import (
	"bytes"
	gocontext "context"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
	"github.com/NoobBandi/TenkStack/server-go/internal/journal"
)

const gpuPoll = 2 * time.Second

// stream is one SSE stream carrying llama-swap events, GPU and host
// samples, container samples and log lines. Merged here so the UI sees a
// single ordered timeline, and so a llama-swap outage does not also stop
// GPU readings.
func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		fail(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ctx := r.Context()
	queue := make(chan api.Event, 256)
	offer := func(ev api.Event) {
		select {
		case queue <- ev:
		default: // a slow client loses events rather than stalling the pumps
		}
	}

	// Nothing is logged in here: this process's own journal is one of the
	// sources, so a line written per line read would feed itself.
	go func() {
		lines, unsubscribe := s.Journal.Subscribe()
		defer unsubscribe()
		for {
			select {
			case <-ctx.Done():
				return
			case line := <-lines:
				offer(api.Event{Type: "journal", Data: line})
			}
		}
	}()
	go func() {
		for ev := range s.LlamaSwap.Events(ctx) {
			offer(ev)
		}
	}()
	go func() {
		events, unsubscribe := s.meters.Subscribe()
		defer unsubscribe()
		for {
			select {
			case <-ctx.Done():
				return
			case ev := <-events:
				offer(ev)
			}
		}
	}()
	go func() {
		for {
			// A list even for one card: the client renders per device.
			if samples := s.History.LatestAll(); len(samples) > 0 {
				offer(api.Event{Type: "gpu", Data: samples})
			}
			// Same tick as the GPU so the two figures describe one moment.
			offer(api.Event{Type: "system", Data: s.System.Sample()})
			if samples := s.Containers.LatestAll(); len(samples) > 0 {
				offer(api.Event{Type: "containers", Data: samples})
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(gpuPoll):
			}
		}
	}()

	// Emitted while something is downloading, plus one snapshot after the
	// last one stops: the tick carrying state=done is exactly the one a
	// pump that only runs while active would skip.
	go func() {
		wasActive := false
		for {
			active := s.Catalog.ActiveCount() > 0
			if active || wasActive {
				offer(api.Event{Type: "downloads", Data: s.Catalog.Status()})
			}
			wasActive = active
			wait := 3 * time.Second
			if active {
				wait = time.Second
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
		}
	}()

	keepalive := time.NewTicker(15 * time.Second)
	defer keepalive.Stop()
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	for {
		select {
		case <-ctx.Done():
			return
		case <-keepalive.C:
			if _, err := w.Write([]byte(": keepalive\n\n")); err != nil {
				return
			}
			flusher.Flush()
		case ev := <-queue:
			buf.Reset()
			buf.WriteString("data: ")
			if err := enc.Encode(ev); err != nil {
				continue
			}
			buf.WriteString("\n")
			if _, err := w.Write(buf.Bytes()); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (s *Server) readLogs(w http.ResponseWriter, r *http.Request) {
	limit, ok := queryInt(w, r, "limit", 400)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, api.LogsPage{Lines: s.Journal.History(limit), Units: s.Journal.UnitLabels()})
}

// queryLogs answers a window from the journal and docker's own files, not
// from the buffer -- see journal.Run. `since` and `until` are unix
// seconds; `units` and `levels` are comma lists; `q` is a substring.
func (s *Server) queryLogs(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	since, ok := queryInt(w, r, "since", int(now.Add(-time.Hour).Unix()))
	if !ok {
		return
	}
	until, ok := queryInt(w, r, "until", int(now.Unix()))
	if !ok {
		return
	}
	limit, ok := queryInt(w, r, "limit", 5000)
	if !ok {
		return
	}
	if limit > 20000 {
		limit = 20000
	}
	set := func(name string) map[string]bool {
		out := map[string]bool{}
		for _, v := range strings.Split(r.URL.Query().Get(name), ",") {
			if v = strings.TrimSpace(v); v != "" {
				out[v] = true
			}
		}
		return out
	}
	// A window can take seconds over a week of journal; longer than that
	// and the page has given up anyway.
	ctx, cancel := gocontext.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	writeJSON(w, http.StatusOK, s.Journal.Run(ctx, journal.Query{
		Since:  time.Unix(int64(since), 0),
		Until:  time.Unix(int64(until), 0),
		Units:  set("units"),
		Levels: set("levels"),
		Text:   strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q"))),
		Noise:  queryBool(r, "noise", false),
		Limit:  limit,
	}))
}

func (s *Server) readLogSources(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.Journal.Sources(r.Context()))
}

func (s *Server) readActivity(w http.ResponseWriter, r *http.Request) {
	limit, ok := queryInt(w, r, "limit", 400)
	if !ok {
		return
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 2000 {
		limit = 2000
	}
	model := r.URL.Query().Get("model")
	writeJSON(w, http.StatusOK, mergeActivity(s.Activity.Recent(limit, model), s.measured(), limit, model))
}

// mergeActivity puts the proxy's measurements in place of llama-swap's rows
// for the same models: for an engine that reports no timings those rows
// divide the reply by the whole request, prefill and even the model's load
// included, and plotted near zero.
func mergeActivity(rows []api.ActivityRow, book *meterBook, limit int, model string) []api.ActivityRow {
	measured := book.Measured()
	out := book.Recent(limit, model)
	for _, r := range rows {
		if r.Model == nil || !measured[*r.Model] {
			out = append(out, r)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return unixOf(out[i].Ts) > unixOf(out[j].Ts) })
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

func unixOf(ts any) int64 {
	switch v := ts.(type) {
	case int64:
		return v
	case int:
		return int64(v)
	case float64:
		return int64(v)
	}
	return 0
}

func (s *Server) readLastUsed(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, api.LastUsed{Model: s.Activity.LastUsed()})
}

func (s *Server) readContainerHistory(w http.ResponseWriter, r *http.Request) {
	seconds, ok := queryInt(w, r, "seconds", 900)
	if !ok {
		return
	}
	points, ok := queryInt(w, r, "points", 240)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, s.Containers.All(&seconds, points))
}
