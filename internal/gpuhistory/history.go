// Package gpuhistory samples every card on a schedule and keeps a window of
// readings, so a dashboard opened now shows the last hours rather than
// starting empty.
package gpuhistory

import (
	"context"
	"log"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/NoobBandi/TenkStack/internal/api"
)

const (
	SampleInterval = 2 * time.Second
	// Cards do not appear at runtime, but the poller starts before xpu-smi
	// necessarily answers.
	discoverEvery = 60 * time.Second
	defaultHours  = 2
)

// Source is what the poller needs from the GPU registry.
type Source interface {
	Indices(ctx context.Context) []int
	Sample(ctx context.Context, index int) *api.GpuSample
}

type History struct {
	source Source

	mu       sync.Mutex
	capacity int
	points   map[int][]api.GpuHistoryPoint
	latest   map[int]api.GpuSample

	cancel context.CancelFunc
	done   chan struct{}
}

func New(source Source) *History {
	return &History{
		source:   source,
		capacity: capacityFor(defaultHours),
		points:   map[int][]api.GpuHistoryPoint{},
		latest:   map[int]api.GpuSample{},
	}
}

func capacityFor(hours int) int {
	return int(float64(hours) * 3600 / SampleInterval.Seconds())
}

// SetHours changes how long samples are kept, trimming buffers already open.
func (h *History) SetHours(hours int) {
	wanted := capacityFor(hours)
	h.mu.Lock()
	defer h.mu.Unlock()
	if wanted == h.capacity {
		return
	}
	h.capacity = wanted
	for index, pts := range h.points {
		if len(pts) > wanted {
			h.points[index] = append([]api.GpuHistoryPoint(nil), pts[len(pts)-wanted:]...)
		}
	}
	log.Printf("GPU history resized to %d hours", hours)
}

func (h *History) Indices() []int {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]int, 0, len(h.latest))
	for i := range h.latest {
		out = append(out, i)
	}
	sort.Ints(out)
	return out
}

// LatestAll is the newest sample for every device, lowest index first.
func (h *History) LatestAll() []api.GpuSample {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]api.GpuSample, 0, len(h.latest))
	for _, i := range sortedKeys(h.latest) {
		out = append(out, h.latest[i])
	}
	return out
}

// Points are one device's recent samples, thinned to at most maxPoints. Long
// windows are decimated rather than truncated so the whole span stays
// visible.
func (h *History) Points(index int, seconds *int, maxPoints int) []api.GpuHistoryPoint {
	h.mu.Lock()
	pts := append([]api.GpuHistoryPoint(nil), h.points[index]...)
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
		thinned := make([]api.GpuHistoryPoint, maxPoints)
		for i := range thinned {
			thinned[i] = pts[int(float64(i)*step)]
		}
		pts = thinned
	}
	if pts == nil {
		pts = []api.GpuHistoryPoint{}
	}
	return pts
}

func (h *History) All(seconds *int, maxPoints int) api.GpuHistory {
	h.mu.Lock()
	indices := sortedKeys(h.points)
	h.mu.Unlock()
	out := api.GpuHistory{Interval: SampleInterval.Seconds(), Devices: map[string][]api.GpuHistoryPoint{}}
	for _, i := range indices {
		out.Devices[strconv.Itoa(i)] = h.Points(i, seconds, maxPoints)
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
	log.Printf("GPU history poller started (%s interval, %d capacity)", SampleInterval, h.capacity)
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
	var known []int
	var discoveredAt time.Time
	for {
		if len(known) == 0 || time.Since(discoveredAt) >= discoverEvery {
			known = h.source.Indices(ctx)
			// Discovery can fail while stats still answer; an empty dashboard
			// is a worse failure than one device without its list entry.
			if len(known) == 0 {
				known = []int{0}
			}
			discoveredAt = time.Now()
		}
		// Sequential: each call shells out, and running them at once makes
		// the readings contend for the driver rather than finish sooner.
		for _, index := range known {
			s := h.source.Sample(ctx, index)
			if s == nil {
				continue
			}
			h.record(index, *s)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(SampleInterval):
		}
	}
}

func (h *History) record(index int, s api.GpuSample) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.latest[index] = s
	pts := append(h.points[index], api.GpuHistoryPoint{
		T:     float64(time.Now().UnixNano()) / 1e9,
		Power: s.PowerW,
		Vram:  s.MemoryUsedMiB,
		Freq:  s.FrequencyMHz,
		Temp:  s.TemperatureC,
		Util:  s.MemoryUtilPercent,
	})
	if len(pts) > h.capacity {
		pts = append([]api.GpuHistoryPoint(nil), pts[len(pts)-h.capacity:]...)
	}
	h.points[index] = pts
}

func sortedKeys[V any](m map[int]V) []int {
	keys := make([]int, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	return keys
}
