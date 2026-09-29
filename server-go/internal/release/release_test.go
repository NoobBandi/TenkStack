package release

import (
	"os"
	"testing"
)

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

// Three updates in a row keep the running binary and the two before it.
func TestRotateKeepsTwo(t *testing.T) {
	dir := t.TempDir()
	exe := dir + "/tenkstack"
	read := func(p string) string { b, _ := os.ReadFile(p); return string(b) }
	os.WriteFile(exe, []byte("v1"), 0o755)
	for _, v := range []string{"v2", "v3", "v4"} {
		os.WriteFile(exe+".new", []byte(v), 0o755)
		if err := rotate(exe, exe+".new"); err != nil {
			t.Fatal(err)
		}
	}
	if read(exe) != "v4" || read(exe+".prev") != "v3" || read(exe+".prev2") != "v2" {
		t.Errorf("got %q %q %q", read(exe), read(exe+".prev"), read(exe+".prev2"))
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 3 {
		t.Errorf("only three files should remain, got %d", len(entries))
	}
}
