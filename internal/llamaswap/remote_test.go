package llamaswap

import (
	"os"
	"path/filepath"
	"testing"
)

// A hand-written entry that routes to a server on another machine (the
// form docs/remote-models.md prescribes) is remote; every other shape of
// proxy -- absent, ${PORT}, a macro, loopback -- stays with the behaviour
// of an entry this machine starts.
func TestRemoteProxy(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, []byte(`models:
  mac-yunshu:
    cmd: sleep 3600
    proxy: http://192.168.1.30:8000
    checkEndpoint: /v1/models
  fixed-local:
    cmd: ${llama-sycl} --port 8999
    proxy: http://127.0.0.1:8999
  ported:
    cmd: ${llama-sycl}
    proxy: http://127.0.0.1:${PORT}
  macro:
    cmd: sleep 3600
    proxy: ${mac-server}
  plain:
    cmd: ${llama-sycl}
  broken-url:
    cmd: sleep 3600
    proxy: "http://%zz"
`), 0o644)
	s := NewStore(path)

	if got := s.RemoteProxy("mac-yunshu"); got != "http://192.168.1.30:8000" {
		t.Errorf("mac-yunshu: got %q", got)
	}
	for _, id := range []string{"fixed-local", "ported", "macro", "plain", "broken-url", "absent"} {
		if got := s.RemoteProxy(id); got != "" {
			t.Errorf("%s: got %q, want no match", id, got)
		}
	}
}
