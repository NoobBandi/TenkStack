package gpu

import (
	"encoding/json"
	"testing"

	"github.com/NoobBandi/TenkStack/internal/api"
)

func TestToFloat(t *testing.T) {
	cases := []struct {
		in   any
		want *float64
	}{
		{nil, nil},
		{true, nil},
		{"N/A", nil},
		{"[Not Supported]", nil},
		{"unknown value", nil},
		{"", nil},
		{"4294967295", nil},
		{json.Number("4294967295"), nil},
		{"12.5 W", Float(12.5)},
		{json.Number("400"), Float(400)},
		{float64(3), Float(3)},
		{"abc", nil},
	}
	for _, c := range cases {
		got := ToFloat(c.in)
		switch {
		case got == nil && c.want == nil:
		case got == nil || c.want == nil || *got != *c.want:
			t.Errorf("ToFloat(%#v) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestText(t *testing.T) {
	if Text(true) != "True" || Text(nil) != "None" || Text(json.Number("17012470")) != "17012470" {
		t.Error("Text does not match Python's str()")
	}
}

func TestBusy(t *testing.T) {
	s := &api.GpuSample{FrequencyMHz: Float(400), FrequencyMaxMHz: Float(2800)}
	if Busy(s) {
		t.Error("idle clock reported busy")
	}
	s.FrequencyMHz = Float(2000)
	if !Busy(s) {
		t.Error("working clock reported idle")
	}
	s.FrequencyMaxMHz = nil
	if Busy(s) {
		t.Error("busy without a maximum")
	}
}
