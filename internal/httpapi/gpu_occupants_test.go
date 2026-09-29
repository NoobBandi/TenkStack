package httpapi

import "testing"

func TestSelects(t *testing.T) {
	intel := []string{"level_zero:{}"}
	cases := []struct {
		entry, device string
		want          bool
	}{
		{"level_zero:0,1", "level_zero:1", true},
		{"level_zero:0,1", "level_zero:0", true},
		{"level_zero:0", "level_zero:1", false},
		{"level_zero:1", "level_zero:1", true},
		{"", "level_zero:0", false},
		{"level_zero:10", "level_zero:1", false},
	}
	for _, c := range cases {
		if got := selects(c.entry, c.device, intel); got != c.want {
			t.Errorf("selects(%q, %q) = %v, want %v", c.entry, c.device, got, c.want)
		}
	}
	// CUDA's variable takes a bare list.
	if !selects("0,1", "1", []string{"{}"}) || selects("0", "1", []string{"{}"}) {
		t.Error("bare index lists")
	}
}
