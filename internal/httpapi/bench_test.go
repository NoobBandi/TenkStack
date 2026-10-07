package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/NoobBandi/TenkStack/internal/api"
	"github.com/NoobBandi/TenkStack/internal/bench"
)

// While a run holds /v1, the proxy answers 503 with Retry-After and the
// message, and lets requests through again once the gate opens.
func TestProxyPausedByBench(t *testing.T) {
	gate := bench.NewGate()
	s := &Server{Bench: &bench.Manager{Gate: gate}}
	gate.Close(time.Now().Add(5*time.Minute), time.Now().Add(time.Hour))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(`{"model":"m"}`))
	req.SetPathValue("path", "chat/completions")
	s.proxyV1(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d", rec.Code)
	}
	retry, _ := strconv.Atoi(rec.Header().Get("Retry-After"))
	if retry < 290 || retry > 300 {
		t.Errorf("Retry-After %q", rec.Header().Get("Retry-After"))
	}
	var body struct {
		Detail string `json:"detail"`
		Error  struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	json.Unmarshal(rec.Body.Bytes(), &body)
	when := time.Now().Add(5 * time.Minute).Local().Format("15:04")
	if !strings.Contains(body.Detail, "正在跑分") || !strings.Contains(body.Detail, when) || body.Error.Message != body.Detail {
		t.Errorf("body %s", rec.Body.String())
	}
	if gate.InFlight() != 0 {
		t.Error("a refused request is not in flight")
	}
	if paused, _ := gate.Paused(); !paused {
		t.Error("still paused")
	}
	gate.Open()
	if leave, _, ok := s.benchGate().Enter(); !ok {
		t.Error("open again")
	} else {
		leave()
	}

	// Without the benchmark wired in, the status is idle and /v1 open.
	var none *bench.Manager
	if st := none.Status(); st.State != api.BenchIdle || st.Results == nil {
		t.Errorf("nil manager status: %+v", st)
	}
	if _, _, ok := (&Server{}).benchGate().Enter(); !ok {
		t.Error("no benchmark, no pause")
	}
}

// The gate holds /v1; the console's own load and unload buttons would
// still swap the model under test, so they are refused too.
func TestManualLoadRefusedDuringBench(t *testing.T) {
	gate := bench.NewGate()
	s := &Server{Bench: &bench.Manager{Gate: gate}}
	gate.Close(time.Now().Add(5*time.Minute), time.Now().Add(time.Hour))
	for name, h := range map[string]http.HandlerFunc{"load": s.loadModel, "unload": s.unloadOne, "unload all": s.unloadAll} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/api/models/m/x", nil)
		req.SetPathValue("id", "m")
		h(rec, req)
		if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "正在跑分") {
			t.Errorf("%s: %d %s", name, rec.Code, rec.Body.String())
		}
	}
	gate.Open()
	if paused, _ := gate.Paused(); paused {
		t.Fatal("the gate should be open")
	}
}
