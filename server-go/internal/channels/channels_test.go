package channels

import (
	"os"
	"path/filepath"
	"testing"
)

const sample = `# ComfyUI behind the console's login.
(comfyui-channel) {
	reverse_proxy 127.0.0.1:{args[0]}
}

# :8188 -- Intel
https://localhost:8444,
https://127.0.0.1:8444 {
	import comfyui-channel 8188
}

# :8189 -- second card
https://localhost:8445,
https://127.0.0.1:8445 {
	import comfyui-channel 8189
}
`

func TestPublishedReadsAddressLinesOnly(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "comfyui.caddy")
	os.WriteFile(p, []byte(sample), 0o644)
	got := published(p)
	if len(got) != 2 || got[0] != 8444 || got[1] != 8445 {
		t.Errorf("published = %v", got)
	}
}

func TestSiteBlockRemovesOneInstance(t *testing.T) {
	out := siteBlock.ReplaceAllStringFunc(sample, func(m string) string {
		if siteBlock.FindStringSubmatch(m)[1] == "8189" {
			return ""
		}
		return m
	})
	if len(out) >= len(sample) || !contains(out, "import comfyui-channel 8188") || contains(out, "8189") {
		t.Errorf("block not removed cleanly:\n%s", out)
	}
	if h := hosts(sample); len(h) != 2 || h[0] != "localhost" {
		t.Errorf("hosts = %v", h)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool { return indexOf(s, sub) >= 0 })()
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
