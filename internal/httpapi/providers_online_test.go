package httpapi

import (
	"testing"

	"github.com/NoobBandi/TenkStack/internal/providers"
)

// vLLM 0.31 renamed online FP8 to fp8_per_tensor and kept fp8 for stored
// FP8 only: an image with the new name gets it, one from before gets the
// old, and an image that cannot be asked gets the record's list.
func TestOfferOnline(t *testing.T) {
	online := []providers.Quant{
		{Value: "fp8_per_tensor", Older: "fp8", Label: "FP8"},
		{Value: "sym_int4", Label: "Int4"},
	}
	values := func(has map[string]bool) []string {
		var out []string
		for _, q := range offerOnline(online, has) {
			out = append(out, q.Value)
		}
		return out
	}
	if got := values(map[string]bool{"fp8": true, "fp8_per_tensor": true, "awq": true}); len(got) != 1 || got[0] != "fp8_per_tensor" {
		t.Errorf("0.31 image: %v", got)
	}
	if got := values(map[string]bool{"fp8": true, "awq": true}); len(got) != 1 || got[0] != "fp8" {
		t.Errorf("0.30 image: %v", got)
	}
	if got := values(nil); len(got) != 2 || got[0] != "fp8_per_tensor" {
		t.Errorf("image not asked: %v", got)
	}
}
