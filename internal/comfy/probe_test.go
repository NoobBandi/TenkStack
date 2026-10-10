package comfy

import "testing"

// The second card's hold counts: qwen-image on xpu:1 left xpu:0 at 0, and
// the console took the instance for idle.
func TestHeldDevice(t *testing.T) {
	gib := float64(1 << 30)
	got := heldDevice([]any{
		map[string]any{"name": "xpu:0 Intel(R) Arc(TM) Pro B70", "torch_vram_total": 0.0},
		map[string]any{"name": "xpu:1 Intel(R) Arc(TM) Pro B70", "torch_vram_total": 9.4 * gib},
	})
	if got["torch_vram_total"] != 9.4*gib || got["name"] != "xpu:1 Intel(R) Arc(TM) Pro B70" {
		t.Errorf("two devices: %v", got)
	}
	split := heldDevice([]any{
		map[string]any{"name": "xpu:0", "torch_vram_total": 3 * gib},
		map[string]any{"name": "xpu:1", "torch_vram_total": 5 * gib},
	})
	if split["torch_vram_total"] != 8*gib {
		t.Errorf("split over two: %v", split)
	}
	if heldDevice(nil) != nil {
		t.Error("no devices")
	}
}
