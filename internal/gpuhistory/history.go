// Package gpuhistory samples every card on a schedule and keeps a window of
// readings, so a dashboard opened now shows the last hours rather than
// starting empty.
package gpuhistory

import (
	"context"
	"encoding/json"
	"log"
	"os"
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

	// file keeps the points across restarts: saved every saveEvery and on
	// Stop, read back on Start. Empty keeps them in memory only.
	file string

	cancel context.CancelFunc
	done   chan struct{}
}

// saveEvery is how often the points are written to file. A crash loses at
// most this much; a restart, which stops cleanly, loses nothing.
const saveEvery = time.Minute

// SetFile names where the points are kept across restarts. Every deploy
// restarts the console, and with the points in memory only, each emptied
// the GPU chart: its 2-hour view showed the few minutes since, the same as
// its 5-minute one.
func (h *History) SetFile(path string) { h.file = path }

// saved is the file's shape: points per card index.
type saved struct {
	Points map[string][]api.GpuHistoryPoint `json:"points"`
}

// load reads the file back, keeping only what is still inside the window.
func (h *History) load() {
	if h.file == "" {
		return
	}
	raw, err := os.ReadFile(h.file)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("could not read GPU history: %v", err)
		}
		return
	}
	var in saved
	if err := json.Unmarshal(raw, &in); err != nil {
		log.Printf("could not read GPU history: %v", err)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	cutoff := float64(time.Now().UnixNano())/1e9 - float64(h.capacity)*SampleInterval.Seconds()
	kept := 0
	for key, pts := range in.Points {
		index, err := strconv.Atoi(key)
		if err != nil {
			continue
		}
		var recent []api.GpuHistoryPoint
		for _, p := range pts {
			if p.T >= cutoff {
				recent = append(recent, p)
			}
		}
		if len(recent) > h.capacity {
			recent = recent[len(recent)-h.capacity:]
		}
		if len(recent) > 0 {
			h.points[index] = recent
			kept += len(recent)
		}
	}
	log.Printf("GPU history: %d points read back", kept)
}

// save writes the points to file, through a temporary one so a crash
// mid-write leaves the last good copy.
func (h *History) save() {
	if h.file == "" {
		return
	}
	h.mu.Lock()
	out := saved{Points: map[string][]api.GpuHistoryPoint{}}
	for index, pts := range h.points {
		out.Points[strconv.Itoa(index)] = append([]api.GpuHistoryPoint(nil), pts...)
	}
	h.mu.Unlock()
	raw, err := json.Marshal(out)
	if err == nil {
		tmp := h.file + ".tmp"
		if err = os.WriteFile(tmp, raw, 0o644); err == nil {
			err = os.Rename(tmp, h.file)
		}
	}
	if err != nil {
		log.Printf("could not save GPU history: %v", err)
	}
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
	h.load()
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
	h.save()
}

func (h *History) poll(ctx context.Context) {
	defer close(h.done)
	var known []int
	var discoveredAt time.Time
	savedAt := time.Now()
	for {
		if time.Since(savedAt) >= saveEvery {
			h.save()
			savedAt = time.Now()
		}
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
