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
	"github.com/NoobBandi/TenkStack/internal/schema"
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

// The figures over the measuring window come from each card's history; a
// card that reports no power leaves its place null, and the load before
// the window counts toward the VRAM peak only.
func TestCardResources(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	runFrom := time.Unix(1000, 0)
	w := bench.Window{From: time.Unix(1010, 0), To: time.Unix(1020, 0), Tokens: 2000}
	card0 := []api.GpuHistoryPoint{
		{T: 1002, Vram: f(30000), Power: f(250)}, // loading: peak, not the window
		{T: 1010, Vram: f(24000), Power: f(100), Freq: f(2400), Temp: f(60)},
		{T: 1015, Vram: f(26000), Power: f(200), Freq: f(2300), Temp: f(72)},
		{T: 1020, Vram: f(25000), Power: f(150), Freq: f(2350), Temp: f(70)},
		{T: 1030, Vram: f(31000), Power: f(300)}, // after: peak only
	}
	card1 := []api.GpuHistoryPoint{{T: 1012, Vram: f(23000)}, {T: 1018, Vram: f(23500)}}
	var out schema.Resources
	cardResources(&out, [][]api.GpuHistoryPoint{card0, card1}, nil, runFrom, w)

	if len(out.VRAMPeakMiB) != 2 || out.VRAMPeakMiB[0] != 31000 || out.VRAMPeakMiB[1] != 23500 {
		t.Errorf("peaks %v", out.VRAMPeakMiB)
	}
	if *out.VRAMLoadedMiB[0] != 24000 || *out.VRAMLoadedMiB[1] != 23000 {
		t.Errorf("loaded %v %v", *out.VRAMLoadedMiB[0], *out.VRAMLoadedMiB[1])
	}
	if *out.PowerAvgW[0] != 150 || *out.PowerMaxW[0] != 200 || out.PowerAvgW[1] != nil {
		t.Errorf("power %v %v %v", *out.PowerAvgW[0], *out.PowerMaxW[0], out.PowerAvgW[1])
	}
	if *out.TempMaxC[0] != 72 || *out.ClockAvgMHz[0] != 2350 || out.TempMaxC[1] != nil {
		t.Errorf("temp %v clock %v", *out.TempMaxC[0], *out.ClockAvgMHz[0])
	}
	// 150 W for 10 s over 2000 tokens.
	if out.EnergyPerTokenJ == nil || *out.EnergyPerTokenJ != 0.75 {
		t.Errorf("energy per token %v", out.EnergyPerTokenJ)
	}
	b, _ := json.Marshal(out)
	if !strings.Contains(string(b), `"power_avg_w":[150,null]`) {
		t.Errorf("a card without power is null in its place: %s", b)
	}

	// No window (a run that failed before measuring): peaks only.
	var bare schema.Resources
	cardResources(&bare, [][]api.GpuHistoryPoint{card0}, nil, runFrom, bench.Window{})
	if bare.PowerAvgW != nil || bare.EnergyPerTokenJ != nil || bare.VRAMLoadedMiB != nil || bare.VRAMPeakMiB[0] != 31000 {
		t.Errorf("no window: %+v", bare)
	}
}

// A card whose energy counter was read every 0.1 s takes its power from
// that: the average is the energy over the window, and the peak a burst
// the history's one-second samples never saw. A card without a counter
// still takes the history's.
func TestCardResourcesMetered(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	runFrom := time.Unix(1000, 0)
	w := bench.Window{From: time.Unix(1010, 0), To: time.Unix(1020, 0), Tokens: 2000}
	history := []api.GpuHistoryPoint{{T: 1012, Vram: f(24000), Power: f(198)}, {T: 1018, Vram: f(24000), Power: f(199)}}
	// 1500 J over the 10 s window (150 W), one 0.1 s burst at 230 W.
	var readings []energyReading
	j := 0.0
	for k := 0; k <= 100; k++ {
		t := 1010 + float64(k)/10
		readings = append(readings, energyReading{t: t, joules: j})
		if k == 50 {
			j += 23
		} else {
			j += (1500 - 23) / 99.0
		}
	}
	readings = append([]energyReading{{t: 1005, joules: -500}}, readings...) // before the window
	var out schema.Resources
	cardResources(&out, [][]api.GpuHistoryPoint{history, history}, [][]energyReading{readings, nil}, runFrom, w)
	if *out.PowerAvgW[0] != 150 || *out.PowerMaxW[0] != 230 {
		t.Errorf("metered: avg %v max %v", *out.PowerAvgW[0], *out.PowerMaxW[0])
	}
	if *out.PowerAvgW[1] != 198.5 || *out.PowerMaxW[1] != 199 {
		t.Errorf("history: avg %v max %v", *out.PowerAvgW[1], *out.PowerMaxW[1])
	}
}
