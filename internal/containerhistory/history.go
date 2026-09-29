// Package containerhistory samples each container's CPU, memory and
// network from cgroup and /proc, for the one question nothing else answers:
// why a container died. Read from the files, not docker stats, which takes
// a second per sample where the files take microseconds.
package containerhistory

import (
	"bufio"
	"context"
	"log"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/NoobBandi/TenkStack/internal/api"
)

const (
	SampleInterval = 2 * time.Second
	// Containers do start and stop while the console runs, but not every
	// two seconds.
	discoverEvery = 10 * time.Second
	capacity      = int(2 * 3600 / 2)
	cgroupRoot    = "/sys/fs/cgroup"
)

type Running struct {
	ID  string
	Pid int
}

type Source interface {
	RunningIDs(ctx context.Context) map[string]Running
}

type SourceFunc func(ctx context.Context) map[string]Running

func (f SourceFunc) RunningIDs(ctx context.Context) map[string]Running { return f(ctx) }

type previous struct {
	at               float64
	usageUsec        int64
	rxBytes, txBytes int64
}

type History struct {
	source Source

	mu     sync.Mutex
	points map[string][]api.ContainerPoint
	latest map[string]api.ContainerSample
	prev   map[string]previous

	cancel context.CancelFunc
	done   chan struct{}
}

func New(source Source) *History {
	return &History{
		source: source,
		points: map[string][]api.ContainerPoint{},
		latest: map[string]api.ContainerSample{},
		prev:   map[string]previous{},
	}
}

// scope is where a container's controllers live: systemd puts each in its
// own scope under system.slice, the cgroupfs driver under docker/.
func scope(id string) string {
	for _, p := range []string{
		filepath.Join(cgroupRoot, "system.slice", "docker-"+id+".scope"),
		filepath.Join(cgroupRoot, "docker", id),
	} {
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			return p
		}
	}
	return ""
}

// network sums bytes in and out over the container's own interfaces, read
// inside its namespace by way of its pid. Loopback is excluded.
func network(pid int) (rx, tx int64, ok bool) {
	f, err := os.Open("/proc/" + strconv.Itoa(pid) + "/net/dev")
	if err != nil {
		return 0, 0, false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for i := 0; sc.Scan(); i++ {
		if i < 2 {
			continue
		}
		face, rest, found := strings.Cut(sc.Text(), ":")
		if !found || strings.TrimSpace(face) == "lo" {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) < 9 {
			continue
		}
		r, err1 := strconv.ParseInt(fields[0], 10, 64)
		t, err2 := strconv.ParseInt(fields[8], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		rx += r
		tx += t
	}
	return rx, tx, true
}

type reading struct {
	memory    int64
	limit     *int64
	usageUsec int64
}

func read(scopeDir string) (reading, bool) {
	var r reading
	b, err := os.ReadFile(filepath.Join(scopeDir, "memory.current"))
	if err != nil {
		return r, false
	}
	if r.memory, err = strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64); err != nil {
		return r, false
	}
	b, err = os.ReadFile(filepath.Join(scopeDir, "memory.max"))
	if err != nil {
		return r, false
	}
	// "max" means no limit was set, which is not a limit of zero.
	if raw := strings.TrimSpace(string(b)); raw != "max" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return r, false
		}
		r.limit = &n
	}
	b, err = os.ReadFile(filepath.Join(scopeDir, "cpu.stat"))
	if err != nil {
		return r, false
	}
	found := false
	for _, line := range strings.Split(string(b), "\n") {
		if key, val, ok := strings.Cut(line, " "); ok && key == "usage_usec" {
			if r.usageUsec, err = strconv.ParseInt(strings.TrimSpace(val), 10, 64); err == nil {
				found = true
			}
		}
	}
	return r, found
}

func (h *History) LatestAll() []api.ContainerSample {
	h.mu.Lock()
	defer h.mu.Unlock()
	names := make([]string, 0, len(h.latest))
	for n := range h.latest {
		names = append(names, n)
	}
	sort.Strings(names)
	out := make([]api.ContainerSample, 0, len(names))
	for _, n := range names {
		out = append(out, h.latest[n])
	}
	return out
}

func (h *History) Points(name string, seconds *int, maxPoints int) []api.ContainerPoint {
	h.mu.Lock()
	pts := append([]api.ContainerPoint(nil), h.points[name]...)
	h.mu.Unlock()
	if seconds != nil {
		cutoff := float64(time.Now().UnixNano())/1e9 - float64(*seconds)
		kept := pts[:0]
		for _, p := range pts {
			if p.T >= cutoff {
				kept = append(kept, p)
			}
		}
		pts = kept
	}
	if maxPoints > 0 && len(pts) > maxPoints {
		step := float64(len(pts)) / float64(maxPoints)
		thinned := make([]api.ContainerPoint, maxPoints)
		for i := range thinned {
			thinned[i] = pts[int(float64(i)*step)]
		}
		pts = thinned
	}
	if pts == nil {
		pts = []api.ContainerPoint{}
	}
	return pts
}

func (h *History) All(seconds *int, maxPoints int) api.ContainerHistory {
	h.mu.Lock()
	names := make([]string, 0, len(h.points))
	for n := range h.points {
		names = append(names, n)
	}
	h.mu.Unlock()
	sort.Strings(names)
	out := api.ContainerHistory{Interval: SampleInterval.Seconds(), Series: map[string][]api.ContainerPoint{}}
	for _, n := range names {
		out.Series[n] = h.Points(n, seconds, maxPoints)
	}
	return out
}

func (h *History) Start(ctx context.Context) {
	if h.cancel != nil {
		return
	}
	ctx, h.cancel = context.WithCancel(ctx)
	h.done = make(chan struct{})
	go h.poll(ctx)
	log.Printf("container history poller started (%s interval)", SampleInterval)
}

func (h *History) Stop() {
	if h.cancel == nil {
		return
	}
	h.cancel()
	<-h.done
	h.cancel = nil
}

func (h *History) poll(ctx context.Context) {
	defer close(h.done)
	var known map[string]Running
	var discoveredAt time.Time
	for {
		if len(known) == 0 || time.Since(discoveredAt) >= discoverEvery {
			known = h.source.RunningIDs(ctx)
			discoveredAt = time.Now()
			// A gone container keeps its history but not a stale "latest",
			// which would read as a live figure on a dead row.
			h.mu.Lock()
			for name := range h.latest {
				if _, still := known[name]; !still {
					delete(h.latest, name)
					delete(h.prev, name)
				}
			}
			h.mu.Unlock()
		}
		h.sampleOnce(known)
		select {
		case <-ctx.Done():
			return
		case <-time.After(SampleInterval):
		}
	}
}

func (h *History) sampleOnce(known map[string]Running) {
	now := float64(time.Now().UnixNano()) / 1e9
	for name, run := range known {
		dir := scope(run.ID)
		if dir == "" {
			continue
		}
		r, ok := read(dir)
		if !ok {
			continue
		}
		rx, tx, _ := network(run.Pid)

		h.mu.Lock()
		prev, had := h.prev[name]
		h.prev[name] = previous{at: now, usageUsec: r.usageUsec, rxBytes: rx, txBytes: tx}
		h.mu.Unlock()

		var percent, rxRate, txRate *float64
		if had {
			if elapsed := now - prev.at; elapsed > 0 {
				p := math.RoundToEven(float64(r.usageUsec-prev.usageUsec)/1e4/elapsed*100) / 100
				percent = &p
				// A counter that went backwards means a restart; a spike that
				// never happened must not be drawn.
				rr := math.RoundToEven(math.Max(0, float64(rx-prev.rxBytes)) / elapsed)
				tt := math.RoundToEven(math.Max(0, float64(tx-prev.txBytes)) / elapsed)
				rxRate, txRate = &rr, &tt
			}
		}
		sample := api.ContainerSample{Name: name, T: now, Memory: r.memory, MemoryLimit: r.limit,
			CPUPercent: percent, NetRx: rxRate, NetTx: txRate}
		h.mu.Lock()
		h.latest[name] = sample
		pts := append(h.points[name], api.ContainerPoint{T: now, Memory: r.memory, CPU: percent, Rx: rxRate, Tx: txRate})
		if len(pts) > capacity {
			pts = append([]api.ContainerPoint(nil), pts[len(pts)-capacity:]...)
		}
		h.points[name] = pts
		h.mu.Unlock()
	}
}
