package bench

import (
	"sync"
	"time"
)

// Gate is the /v1 pause. The console's /v1 proxy is the one way
// in for outside clients -- llama-swap listens on 127.0.0.1 only -- so it is
// the one place that asks. It also counts the requests in flight, which is
// what draining waits for. It lives in memory only: a restart lifts it.
//
// A nil *Gate admits everything, so a console without the benchmark wired
// in (tests) needs no special case.
type Gate struct {
	mu       sync.Mutex
	closed   bool
	resumeAt time.Time
	// deadline is the hard limit: past it requests are admitted again even
	// though nobody opened the gate, so a run that hangs cannot hold every
	// client off for good.
	deadline time.Time
	inFlight int
	now      func() time.Time
}

func NewGate() *Gate { return &Gate{now: time.Now} }

func (g *Gate) clock() time.Time {
	if g.now != nil {
		return g.now()
	}
	return time.Now()
}

// Enter admits one /v1 request, or says when to come back. leave must be
// called when the request is done, response streamed and all.
func (g *Gate) Enter() (leave func(), resumeAt time.Time, ok bool) {
	if g == nil {
		return func() {}, time.Time{}, true
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed && g.clock().Before(g.deadline) {
		return nil, g.resumeAt, false
	}
	g.inFlight++
	var once sync.Once
	return func() {
		once.Do(func() {
			g.mu.Lock()
			g.inFlight--
			g.mu.Unlock()
		})
	}, time.Time{}, true
}

// InFlight is how many /v1 requests are running now.
func (g *Gate) InFlight() int {
	if g == nil {
		return 0
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.inFlight
}

// Close turns new /v1 requests away until Open, or until deadline.
func (g *Gate) Close(resumeAt, deadline time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.closed, g.resumeAt, g.deadline = true, resumeAt, deadline
}

// SetResume moves the time the refusal promises, as the run learns how
// long it really takes. The hard deadline does not move.
func (g *Gate) SetResume(resumeAt time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		g.resumeAt = resumeAt
	}
}

func (g *Gate) Open() {
	if g == nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.closed = false
}

// Paused says whether /v1 is refusing requests now, and until when.
func (g *Gate) Paused() (bool, time.Time) {
	if g == nil {
		return false, time.Time{}
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed && g.clock().Before(g.deadline) {
		return true, g.resumeAt
	}
	return false, time.Time{}
}
