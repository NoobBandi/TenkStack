package bench

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/NoobBandi/TenkStack/internal/api"
	"github.com/NoobBandi/TenkStack/internal/schema"
)

func TestGate(t *testing.T) {
	now := time.Unix(1000, 0)
	g := &Gate{now: func() time.Time { return now }}

	leave, _, ok := g.Enter()
	if !ok || g.InFlight() != 1 {
		t.Fatal("an open gate admits and counts")
	}
	g.Close(now.Add(time.Minute), now.Add(10*time.Minute))
	if _, resume, ok := g.Enter(); ok || !resume.Equal(now.Add(time.Minute)) {
		t.Errorf("a closed gate refuses and says when: %v %v", ok, resume)
	}
	g.SetResume(now.Add(2 * time.Minute))
	if paused, resume := g.Paused(); !paused || !resume.Equal(now.Add(2*time.Minute)) {
		t.Errorf("paused %v until %v", paused, resume)
	}

	leave()
	leave() // twice is once
	if g.InFlight() != 0 {
		t.Error("leave counts the request out")
	}
	if l, _, ok := (&Gate{}).Enter(); !ok {
		t.Error("never closed")
	} else {
		l()
	}

	// Past the hard deadline the gate admits again by itself.
	now = now.Add(11 * time.Minute)
	if l, _, ok := g.Enter(); !ok {
		t.Error("the hard limit lifts the pause")
	} else {
		l()
	}
	g.Open()
	if paused, _ := g.Paused(); paused {
		t.Error("open")
	}

	var nilGate *Gate
	if l, _, ok := nilGate.Enter(); !ok || nilGate.InFlight() != 0 {
		t.Error("a nil gate admits everything")
	} else {
		l()
	}
}

func TestUnloads(t *testing.T) {
	groups := []Group{
		{Name: "small", Swap: false, Exclusive: false, Members: []string{"s1", "s2"}},
		{Name: "large", Swap: true, Exclusive: true, Members: []string{"l1", "l2"}},
		{Name: "keep", Swap: true, Exclusive: false, Persistent: true, Members: []string{"p"}},
	}
	cases := []struct {
		running []string
		model   string
		want    []string
	}{
		{[]string{"s1", "l1", "p"}, "l2", []string{"l1", "s1"}}, // exclusive and swapping; persistent stays
		{[]string{"s1", "l1"}, "s2", []string{}},                // small neither swaps nor excludes
		{[]string{"s1", "l1"}, "l1", []string{}},                // already loaded
		{[]string{"s1", "loose"}, "other", []string{"loose", "s1"}},
	}
	for _, c := range cases {
		if got := Unloads(groups, c.running, c.model); !slices.Equal(got, c.want) {
			t.Errorf("%s with %v: %v, want %v", c.model, c.running, got, c.want)
		}
	}
}

func TestExportScrubs(t *testing.T) {
	sub := Assemble(SuiteV1(), Description{
		ModelID: "m", Command: "/home/tenk/ai/run.sh",
		Model:  schema.ModelRef{Format: "gguf", Repo: "/home/tenk/models/x", File: "/home/tenk/models/x/q6.gguf", Quant: "Q6_K"},
		Engine: schema.EngineRef{Key: "llamacpp", Image: "/home/tenk/img.tar"},
		Tuning: schema.Tuning{ContextLength: 4096, Speculative: &schema.Speculative{Methods: []string{"draft"},
			DraftModel: &schema.ModelRef{File: "${models-dir}/d.gguf"}}},
		Unrecognized: []string{"--foo=/home/tenk/bar", "--baz"},
	}, "1.2.3", api.BenchQuick, Outcome{}, schema.Resources{}, time.Unix(0, 0), time.Minute, true)
	out := Export(sub)
	if out.Model.Repo != "" || out.Model.File != "q6.gguf" || out.Engine.Image != "" ||
		out.Tuning.Speculative.DraftModel.File != "d.gguf" || !slices.Equal(out.UnrecognizedFlags, []string{"--foo", "--baz"}) {
		t.Errorf("export: %+v", out)
	}
	if sub.Tuning.Speculative.DraftModel.File != "${models-dir}/d.gguf" {
		t.Error("export changed the stored submission")
	}
	if sub.Schema != schema.BenchV1 || sub.Client.Name != "tenkstack" || sub.Client.Version != "1.2.3" ||
		sub.Suite.ID != "tenkstack-bench" || !sub.Run.ExternalPaused || !sub.Run.Clean || sub.Run.Tier != "quick" ||
		sub.Results == nil || sub.Resources.VRAMPeakMiB == nil {
		t.Errorf("assembled: %+v", sub)
	}
}

type fixedDescriber struct{ d Description }

func (f fixedDescriber) Describe(context.Context, string) (Description, error) { return f.d, nil }

type fakeMachine struct{ comfy bool }

func (fakeMachine) Groups(context.Context) []Group           { return nil }
func (fakeMachine) Names(context.Context) map[string]string  { return map[string]string{"m": "M"} }
func (m fakeMachine) ComfyBusy(context.Context, string) bool { return m.comfy }
func (fakeMachine) Watch(context.Context, string) func() schema.Resources {
	return func() schema.Resources { return schema.Resources{VRAMPeakMiB: []int{1000, 2000}, RAMPeakMiB: 300} }
}

func newManager(t *testing.T, f *fakeEngine) *Manager {
	r, _ := newFake(t, f)
	return &Manager{Runner: r, Describer: fixedDescriber{describe("llamacpp", 0)}, Gate: NewGate(),
		Machine: fakeMachine{}, Sampler: fakeMachine{}, Version: "t", progress: idle(), DrainTimeout: 300 * time.Millisecond}
}

func TestManagerRunsAndReleases(t *testing.T) {
	f := &fakeEngine{loaded: true, perToken: time.Millisecond}
	m := newManager(t, f)
	p, err := m.Start(context.Background(), api.BenchRunRequest{Model: "m", Tier: api.BenchQuick})
	if err != nil || p.State != api.BenchDraining || p.ResumeAt == 0 || p.Total != 6 {
		t.Fatalf("start: %+v %v", p, err)
	}
	if paused, _ := m.Gate.Paused(); !paused {
		t.Error("/v1 is paused while it runs")
	}
	if _, err := m.Start(context.Background(), api.BenchRunRequest{Model: "m", Tier: api.BenchQuick}); err == nil {
		t.Error("a second run while one runs")
	} else if e := (*Error)(nil); !errors.As(err, &e) || e.Status != http.StatusConflict {
		t.Errorf("second run: %v", err)
	}
	m.Wait()
	st := m.Status()
	if st.State != api.BenchDone || len(st.Results) != 6 || st.Done != 6 {
		t.Errorf("done: %+v", st)
	}
	if paused, _ := m.Gate.Paused(); paused {
		t.Error("released when done")
	}
}

func TestManagerDrainTimeoutAndForce(t *testing.T) {
	f := &fakeEngine{loaded: true}
	m := newManager(t, f)
	m.DrainGrace = 300 * time.Millisecond
	defer func(p time.Duration) { drainPoll = p }(drainPoll)
	drainPoll = 10 * time.Millisecond
	leave, _, _ := m.Gate.Enter() // an outside request that does not end
	defer leave()
	start := func(force bool) (api.BenchProgress, error) {
		return m.Start(context.Background(), api.BenchRunRequest{Model: "m", Tier: api.BenchQuick, Force: force})
	}
	if _, err := start(false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if st := m.Status(); st.State != api.BenchDraining || st.InFlight != 1 || st.DrainTimedOut || !strings.Contains(st.Message, "1 個") {
		t.Errorf("draining: %+v", st)
	}
	// Past the timeout it says so and keeps waiting; past the grace with
	// no answer it cancels itself.
	time.Sleep(400 * time.Millisecond)
	if st := m.Status(); st.State != api.BenchDraining || !st.DrainTimedOut {
		t.Errorf("timed out, still waiting: %+v", st)
	}
	m.Wait()
	st := m.Status()
	if st.State != api.BenchCancelled || st.Error == "" || st.Model != "m" || st.ElapsedS == 0 {
		t.Errorf("gave up: %+v", st)
	}
	if paused, _ := m.Gate.Paused(); paused || len(f.bodies) != 0 {
		t.Error("released, and nothing was sent")
	}

	// Forcing the run that is draining starts it, rather than a 409.
	if _, err := start(false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if _, err := m.Start(context.Background(), api.BenchRunRequest{Model: "other", Tier: api.BenchQuick, Force: true}); err == nil {
		t.Error("force for another model")
	}
	if p, err := start(true); err != nil || p.Model != "m" {
		t.Fatalf("force: %+v %v", p, err)
	}
	m.Wait()
	if st := m.Status(); st.State != api.BenchDone || st.RunID != nil || len(st.Results) != 6 {
		t.Errorf("forced: %+v", st)
	}
}

func TestManagerCancel(t *testing.T) {
	f := &fakeEngine{loaded: true, perToken: 20 * time.Millisecond}
	m := newManager(t, f)
	if _, err := m.Start(context.Background(), api.BenchRunRequest{Model: "m", Tier: api.BenchFull}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	st := m.Cancel()
	if st.State != api.BenchCancelled {
		t.Errorf("cancel: %+v", st)
	}
	if paused, _ := m.Gate.Paused(); paused {
		t.Error("released on cancel")
	}
}

func TestManagerRefusals(t *testing.T) {
	m := newManager(t, &fakeEngine{loaded: true})
	var e *Error
	if _, err := m.Start(context.Background(), api.BenchRunRequest{Model: "m", Tier: "slow"}); !errors.As(err, &e) || e.Status != 422 {
		t.Errorf("bad tier: %v", err)
	}
	m.Machine = fakeMachine{comfy: true}
	if _, err := m.Start(context.Background(), api.BenchRunRequest{Model: "m", Tier: api.BenchQuick}); !errors.As(err, &e) || e.Status != 409 {
		t.Errorf("ComfyUI busy: %v", err)
	}
	plan, err := m.Plan(context.Background(), "m", api.BenchFull)
	if err != nil || !plan.ComfyBusy || !plan.Loaded || len(plan.Cases) != 11 || plan.EstimatedS == 0 || plan.Unloads == nil || plan.Name != "M" {
		t.Errorf("plan: %+v %v", plan, err)
	}
	if m.Status().State != api.BenchIdle {
		t.Error("refusals start nothing")
	}
}
