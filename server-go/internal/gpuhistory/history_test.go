package gpuhistory

import (
	"context"
	"testing"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
)

type fake struct{ n float64 }

func (f *fake) Indices(context.Context) []int { return []int{0, 1} }
func (f *fake) Sample(_ context.Context, index int) *api.GpuSample {
	f.n++
	return &api.GpuSample{Index: index, PowerW: &f.n}
}

func TestThinningKeepsTheWholeSpan(t *testing.T) {
	h := New(&fake{})
	for i := 0; i < 1000; i++ {
		h.record(0, api.GpuSample{PowerW: floatp(float64(i))})
	}
	pts := h.Points(0, nil, 100)
	if len(pts) != 100 {
		t.Fatalf("got %d points", len(pts))
	}
	if *pts[0].Power != 0 || *pts[99].Power != 990 {
		t.Errorf("thinning did not span the buffer: first %v last %v", *pts[0].Power, *pts[99].Power)
	}
}

func TestCapacityAndResize(t *testing.T) {
	h := New(&fake{})
	h.SetHours(1)
	for i := 0; i < h.capacity+50; i++ {
		h.record(0, api.GpuSample{})
	}
	if got := len(h.points[0]); got != h.capacity {
		t.Errorf("buffer holds %d, capacity %d", got, h.capacity)
	}
	all := h.All(nil, 0)
	if all.Interval != 2 || len(all.Devices["0"]) != h.capacity {
		t.Errorf("All() = interval %v, %d points", all.Interval, len(all.Devices["0"]))
	}
}

func floatp(f float64) *float64 { return &f }
