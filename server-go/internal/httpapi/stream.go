package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"time"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
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
	writeJSON(w, http.StatusOK, s.Activity.Recent(limit, r.URL.Query().Get("model")))
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
