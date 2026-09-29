package release

import "testing"

func TestNewer(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"0.7.0", "0.6.0", true},
		{"v0.7.0", "0.6.0", true},
		{"0.6.0", "0.6.0", false},
		{"0.6.1", "0.6.0", true},
		{"0.10.0", "0.9.0", true},
		{"1.0.0", "0.99.99", true},
		{"0.6.0", "0.7.0", false},
		{"0.7.0-rc1", "0.6.0", true},
		{"0.7.0", "0.7.0-rc1", true},
		{"0.7.0-rc1", "0.7.0", false},
		{"", "0.6.0", false},
	}
	for _, c := range cases {
		if got := Newer(c.a, c.b); got != c.want {
			t.Errorf("Newer(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}
