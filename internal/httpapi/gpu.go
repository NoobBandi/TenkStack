package httpapi

import (
	"net/http"
	"strconv"

	"github.com/NoobBandi/TenkStack/internal/api"
)

// readGpu is the live counters for every card, lowest index first. Before
// the poller's first tick it asks directly rather than answering with an
// empty list the UI would read as "no GPU".
func (s *Server) readGpu(w http.ResponseWriter, r *http.Request) {
	samples := s.History.LatestAll()
	if len(samples) == 0 {
		if one := s.Gpu.Sample(r.Context(), 0); one != nil {
			samples = []api.GpuSample{*one}
		}
	}
	if len(samples) == 0 {
		writeJSON(w, http.StatusOK, api.GpuUnavailable{Error: "xpu-smi unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, samples)
}

func (s *Server) readGpuHistory(w http.ResponseWriter, r *http.Request) {
	seconds, ok := queryInt(w, r, "seconds", 900)
	if !ok {
		return
	}
	points, ok := queryInt(w, r, "points", 600)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, s.History.All(&seconds, points))
}

func (s *Server) readGpuDevices(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.Gpu.ListDevices(r.Context()))
}

// queryInt reads an integer query parameter with a default; a non-integer is
// 422, as FastAPI answers it.
func queryInt(w http.ResponseWriter, r *http.Request, name string, fallback int) (int, bool) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return fallback, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		fail(w, http.StatusUnprocessableEntity, name+" must be an integer")
		return 0, false
	}
	return n, true
}
