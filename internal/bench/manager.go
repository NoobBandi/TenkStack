package bench

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/NoobBandi/TenkStack/internal/api"
	"github.com/NoobBandi/TenkStack/internal/schema"
)

// Machine is what a plan needs to know about the rest of the console.
type Machine interface {
	// Groups is llama-swap's groups as config.yaml has them now.
	Groups(ctx context.Context) []Group
	// ComfyBusy says whether ComfyUI is drawing, or has drawings queued,
	// on the cards the model uses.
	ComfyBusy(ctx context.Context, modelID string) bool
	// Names is each configured model's display name by id.
	Names(ctx context.Context) map[string]string
}

// Sampler watches a model's resources while it is measured: VRAM per card
// it uses, and host memory -- its container's, or for an engine that runs
// natively, the processes llama-swap started.
type Sampler interface {
	Watch(ctx context.Context, modelID string) (stop func(Window) schema.Resources)
}

// Window is the measuring part of a run, which the averages and the
// energy cover, and the tokens generated in it.
type Window struct {
	From, To time.Time
	Tokens   int
}

// Error is a refusal to plan or start, with the status it answers with.
type Error struct {
	Status int
	Msg    string
}

func (e *Error) Error() string { return e.Msg }

// Manager runs one benchmark at a time in the background and holds /v1
// while it does.
type Manager struct {
	Runner    *Runner // its Suite is what every run follows
	Describer Describer
	Runs      *Runs // nil keeps nothing (tests)
	Gate      *Gate
	Machine   Machine
	Sampler   Sampler // nil: no resource peaks
	Version   string

	// DrainTimeout and DrainGrace override drainTimeout and drainGrace,
	// for tests.
	DrainTimeout time.Duration
	DrainGrace   time.Duration

	mu       sync.Mutex
	progress api.BenchProgress
	cancel   context.CancelFunc
	done     chan struct{}
	// force is closed to stop a drain and start now; forced says it has
	// been, since a channel closes once.
	force  chan struct{}
	forced bool
	// began is when the run started draining, to the nanosecond; the
	// progress keeps whole seconds.
	began time.Time
	// choice is what the current run measures.
	choice Choice
}

// NewManager is a manager running the built-in suite against llama-swap at
// base.
func NewManager(base string, d Describer, runs *Runs, m Machine, s Sampler, version string) *Manager {
	return &Manager{
		Runner:    &Runner{Base: base, Suite: SuiteV1()},
		Describer: d, Runs: runs, Gate: NewGate(), Machine: m, Sampler: s, Version: version,
		progress: idle(),
	}
}

func idle() api.BenchProgress {
	return api.BenchProgress{State: api.BenchIdle, Results: []schema.CaseResult{}}
}

func active(state string) bool { return state == api.BenchDraining || state == api.BenchRunning }

// Plan is what a run would do, for the confirmation.
func (m *Manager) Plan(ctx context.Context, model string, ch Choice) (api.BenchPlan, error) {
	p, _, err := m.plan(ctx, model, ch)
	return p, err
}

// ChoiceOf is what a run request asks to measure.
func ChoiceOf(req api.BenchRunRequest) Choice {
	return Choice{Tier: req.Tier, Cases: req.Cases, Repeats: req.Repeats}
}

func (m *Manager) plan(ctx context.Context, model string, ch Choice) (api.BenchPlan, Description, error) {
	if err := ch.Check(m.Runner.Suite); err != nil {
		return api.BenchPlan{}, Description{}, &Error{http.StatusUnprocessableEntity, err.Error()}
	}
	tier := ch.Tier
	d, err := m.Describer.Describe(ctx, model)
	if err != nil {
		return api.BenchPlan{}, d, fmt.Errorf("讀不到模型 %s 的設定：%w", model, err)
	}
	cases, skipped := Select(m.Runner.Suite, ch, d.ContextLimit())
	ids := make([]string, 0, len(cases))
	for _, c := range cases {
		ids = append(ids, c.ID)
	}
	running, err := m.Runner.Running(ctx)
	if err != nil {
		log.Printf("bench: llama-swap /running: %v", err)
	}
	names := make([]string, 0, len(running))
	for id := range running {
		names = append(names, id)
	}
	sort.Strings(names)
	var groups []Group
	var display map[string]string
	comfy := false
	if m.Machine != nil {
		groups = m.Machine.Groups(ctx)
		comfy = m.Machine.ComfyBusy(ctx, d.ModelID)
		display = m.Machine.Names(ctx)
	}
	// The confirmation lists them as people know them.
	unloads := Unloads(groups, names, d.ModelID)
	for i, id := range unloads {
		if n := display[id]; n != "" {
			unloads[i] = n
		}
	}
	loaded := running[d.ModelID] == "ready"
	if skipped == nil {
		skipped = []string{}
	}
	return api.BenchPlan{
		Model:         d.ModelID,
		Name:          d.Name,
		Engine:        d.Engine.Key,
		Tier:          tier,
		Cases:         ids,
		Skipped:       skipped,
		Unloads:       unloads,
		Loaded:        loaded,
		Context:       d.ContextLimit(),
		ContextServed: d.ServedContext > 0,
		EstimatedS:    m.estimate(ctx, d.ModelID, ch, cases, loaded),
		InFlight:      m.Gate.InFlight(),
		ComfyBusy:     comfy,
	}, d, nil
}

// estimate prefers how long this model and tier took last time; a custom
// run's cases differ from one to the next, so it is always worked out.
func (m *Manager) estimate(ctx context.Context, model string, ch Choice, cases []schema.BenchCase, loaded bool) int {
	if m.Runs != nil && ch.Tier != api.BenchCustom {
		if last, ok := m.Runs.LastDuration(ctx, model, ch.Tier); ok {
			if !loaded {
				last += assumedColdS
			}
			return int(last + 0.5)
		}
	}
	return Estimate(m.Runner.Suite, ch, cases, loaded)
}

// Status is the run now, or the last one to finish.
func (m *Manager) Status() api.BenchProgress {
	if m == nil {
		return idle()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	p := m.progress
	p.Results = append([]schema.CaseResult{}, p.Results...)
	if active(p.State) {
		p.ElapsedS = round(time.Since(m.began).Seconds(), 1)
		if p.State == api.BenchDraining {
			p.InFlight = m.Gate.InFlight()
		}
	}
	return p
}

// Start begins a run and returns at once; the run itself drains /v1 first.
func (m *Manager) Start(ctx context.Context, req api.BenchRunRequest) (api.BenchProgress, error) {
	m.mu.Lock()
	cur := m.progress
	busy := active(cur.State)
	// Force for the run already draining is the owner's answer to a drain
	// that is taking too long: stop waiting and start.
	same := busy && req.Force && cur.Model == req.Model && m.choice.Same(ChoiceOf(req))
	if same && cur.State == api.BenchDraining {
		m.forceLocked()
	}
	m.mu.Unlock()
	if same {
		return m.Status(), nil
	}
	if busy {
		return m.Status(), &Error{http.StatusConflict, "已經有一個跑分在進行"}
	}
	plan, d, err := m.plan(ctx, req.Model, ChoiceOf(req))
	if err != nil {
		return m.Status(), err
	}
	if len(plan.Cases) == 0 {
		return m.Status(), &Error{http.StatusUnprocessableEntity, "這個檔次沒有能跑的項目：" + fmt.Sprint(plan.Skipped)}
	}
	if plan.ComfyBusy && !req.Force {
		return m.Status(), &Error{http.StatusConflict, "ComfyUI 正在算圖，佔著同一張顯示卡。等它跑完或先中斷，或選擇強制開始"}
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if active(m.progress.State) {
		return m.progress, &Error{http.StatusConflict, "已經有一個跑分在進行"}
	}
	now := time.Now()
	estimate := time.Duration(plan.EstimatedS) * time.Second
	deadline := now.Add(m.drainTimeout() + m.drainGrace() + hardLimit(estimate))
	m.Gate.Close(now.Add(estimate), deadline)
	runCtx, cancel := context.WithDeadline(context.Background(), deadline)
	m.cancel = cancel
	m.done = make(chan struct{})
	m.force, m.forced = make(chan struct{}), false
	m.began = now
	m.choice = ChoiceOf(req)
	if req.Force {
		m.forceLocked()
	}
	m.progress = api.BenchProgress{
		State:     api.BenchDraining,
		Model:     d.ModelID,
		Tier:      req.Tier,
		Cases:     req.Cases,
		Repeats:   req.Repeats,
		StartedAt: now.Unix(),
		Total:     len(plan.Cases),
		InFlight:  m.Gate.InFlight(),
		ResumeAt:  now.Add(estimate).Unix(),
		Message:   "暫停對外服務，等待進行中的請求結束",
		Results:   []schema.CaseResult{},
	}
	go m.run(runCtx, cancel, m.done, m.force, d, req, estimate)
	return m.progress, nil
}

func (m *Manager) forceLocked() {
	if m.force != nil && !m.forced {
		close(m.force)
		m.forced = true
	}
}

func (m *Manager) drainTimeout() time.Duration {
	if m.DrainTimeout > 0 {
		return m.DrainTimeout
	}
	return drainTimeout
}

func (m *Manager) drainGrace() time.Duration {
	if m.DrainGrace > 0 {
		return m.DrainGrace
	}
	return drainGrace
}

type drained int

const (
	drainedEmpty  drained = iota // nothing left in flight
	drainedForced                // the owner said start anyway
	drainedGaveUp                // timed out, and nobody forced it within the grace
	drainedEnded                 // the run's context ended
)

// drain waits for the /v1 requests in flight to finish. Past the timeout
// it says so -- the UI then offers to force the start -- and keeps
// waiting, for the owner to force or cancel; only past a further grace,
// with nobody answering, does it give up on its own.
func (m *Manager) drain(ctx context.Context, force <-chan struct{}) drained {
	start := time.Now()
	last, timedOut := -1, false
	for {
		n := m.Gate.InFlight()
		if n == 0 {
			return drainedEmpty
		}
		select {
		case <-force:
			return drainedForced
		default:
		}
		waited := time.Since(start)
		if !timedOut && waited >= m.drainTimeout() {
			timedOut = true
			last = -1
		}
		if timedOut && waited >= m.drainTimeout()+m.drainGrace() {
			return drainedGaveUp
		}
		if n != last {
			last = n
			m.update(func(p *api.BenchProgress) {
				p.InFlight = n
				if timedOut {
					p.DrainTimedOut = true
					p.Message = fmt.Sprintf("等了 %s仍有 %d 個請求在進行：可以強制開始或取消；再過 %s沒有選擇就自動取消",
						spoken(m.drainTimeout()), n, spoken(m.drainGrace()))
				} else {
					p.Message = fmt.Sprintf("暫停對外服務，等待 %d 個進行中的請求結束", n)
				}
			})
		}
		select {
		case <-ctx.Done():
			return drainedEnded
		case <-force:
			return drainedForced
		case <-time.After(drainPoll):
		}
	}
}

// update changes the progress under the lock.
func (m *Manager) update(fn func(p *api.BenchProgress)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	fn(&m.progress)
}

func (m *Manager) finish(state, message, errText string) {
	m.Gate.Open()
	m.update(func(p *api.BenchProgress) {
		p.State, p.Message, p.Error = state, message, errText
		p.ResumeAt = 0
		p.InFlight = 0
		p.ElapsedS = round(time.Since(m.began).Seconds(), 1)
	})
}

func (m *Manager) run(ctx context.Context, cancel context.CancelFunc, done, force chan struct{}, d Description,
	req api.BenchRunRequest, estimate time.Duration) {
	defer close(done)
	defer cancel()
	// Whatever happens below, /v1 comes back.
	defer m.Gate.Open()
	defer func() {
		if r := recover(); r != nil {
			log.Printf("bench: run panicked: %v", r)
			m.finish(api.BenchFailed, "跑分中斷", fmt.Sprint(r))
		}
	}()

	switch m.drain(ctx, force) {
	case drainedEnded:
		m.ended(ctx)
		return
	case drainedGaveUp:
		m.finish(api.BenchCancelled, "已取消：進行中的請求一直沒有結束，也沒有選擇強制開始",
			fmt.Sprintf("等了 %s仍有 %d 個請求在進行", spoken(m.drainTimeout()+m.drainGrace()), m.Gate.InFlight()))
		return
	}
	if ctx.Err() != nil {
		m.ended(ctx)
		return
	}
	// Forced past requests still running: they share the card with the
	// measurements, so the run says it is not clean.
	clean := m.Gate.InFlight() == 0

	started := time.Now()
	m.update(func(p *api.BenchProgress) {
		p.State = api.BenchRunning
		p.InFlight = 0
		p.ResumeAt = started.Add(estimate).Unix()
		p.Message = "開始跑分"
	})
	m.Gate.SetResume(started.Add(estimate))
	var stop func(Window) schema.Resources
	if m.Sampler != nil {
		stop = m.Sampler.Watch(ctx, d.ModelID)
	}
	outcome, err := m.Runner.Run(ctx, d, ChoiceOf(req), func(s Step) {
		resume := time.Time{}
		if s.Done > 0 && s.Total > 0 {
			// Re-estimate from the pace so far: a slow model's message
			// would otherwise promise a time long past.
			per := time.Since(started) / time.Duration(s.Done)
			resume = time.Now().Add(per * time.Duration(s.Total-s.Done))
			m.Gate.SetResume(resume)
		}
		m.update(func(p *api.BenchProgress) {
			p.Case, p.Done, p.Total, p.Message = s.Case, s.Done, s.Total, s.Message
			p.Results, p.Skipped = s.Results, s.Skipped
			if !resume.IsZero() {
				p.ResumeAt = resume.Unix()
			}
		})
	})
	resources := schema.Resources{VRAMPeakMiB: []int{}}
	if stop != nil {
		resources = stop(Window{From: outcome.MeasuredFrom, To: outcome.MeasuredTo, Tokens: outcome.Generated})
	}
	if ctx.Err() != nil {
		m.ended(ctx)
		return
	}
	if err != nil {
		m.finish(api.BenchFailed, "跑分失敗", err.Error())
		return
	}
	clean = clean && m.Gate.InFlight() == 0
	sub := Assemble(m.Runner.Suite, d, m.Version, req.Tier, outcome, resources, started, time.Since(started), clean)
	m.update(func(p *api.BenchProgress) {
		p.Results, p.Skipped = sub.Results, outcome.Skipped
	})
	if m.Runs != nil {
		saveCtx, cancelSave := context.WithTimeout(context.Background(), 10*time.Second)
		id, err := m.Runs.Save(saveCtx, d, sub, started)
		cancelSave()
		if err != nil {
			m.finish(api.BenchFailed, "跑完了，但成績存不進資料庫", err.Error())
			return
		}
		m.update(func(p *api.BenchProgress) { p.RunID = &id })
	}
	m.finish(api.BenchDone, "跑分完成", "")
}

// ended reports a run its context stopped: cancelled by the owner, or out
// of time.
func (m *Manager) ended(ctx context.Context) {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		m.finish(api.BenchFailed, "超過最長時限，已停止跑分", "跑分超過預估時間的兩倍仍未結束")
		return
	}
	m.finish(api.BenchCancelled, "已取消跑分", "")
}

// Cancel stops the run, if any, and lifts the pause at once.
func (m *Manager) Cancel() api.BenchProgress {
	m.mu.Lock()
	cancel, done := m.cancel, m.done
	running := active(m.progress.State)
	m.mu.Unlock()
	if !running || cancel == nil {
		return m.Status()
	}
	m.Gate.Open()
	cancel()
	// The runner's requests end with their context; give it a moment so
	// the answer already says cancelled.
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
	return m.Status()
}

// Wait blocks until the current run, if any, has finished. For tests and
// shutdown.
func (m *Manager) Wait() {
	m.mu.Lock()
	done := m.done
	m.mu.Unlock()
	if done != nil {
		<-done
	}
}

// spoken is a wait as a person would say it.
func spoken(d time.Duration) string {
	if d >= time.Minute {
		return fmt.Sprintf("%d 分鐘", int(d.Round(time.Minute).Minutes()))
	}
	return fmt.Sprintf("%d 秒", int(d.Round(time.Second).Seconds()))
}
