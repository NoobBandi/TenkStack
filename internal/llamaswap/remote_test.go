package llamaswap

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/NoobBandi/TenkStack/internal/api"
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
  tunnel:
    cmd: |
      # ssh -L lands on loopback; the placeholder is what says this is a
      # server elsewhere reached through it, not one of ours on a fixed port.
      sleep 3600
    proxy: http://127.0.0.1:8100
  broken-url:
    cmd: sleep 3600
    proxy: "http://%zz"
`), 0o644)
	s := NewStore(path)

	if got := s.RemoteProxy("mac-yunshu"); got != "http://192.168.1.30:8000" {
		t.Errorf("mac-yunshu: got %q", got)
	}
	// Loopback with the console's placeholder is a tunnel to a server
	// elsewhere; loopback without it is a local server on a fixed port.
	if got := s.RemoteProxy("tunnel"); got != "http://127.0.0.1:8100" {
		t.Errorf("tunnel: got %q", got)
	}
	for _, id := range []string{"fixed-local", "ported", "macro", "plain", "broken-url", "absent"} {
		if got := s.RemoteProxy(id); got != "" {
			t.Errorf("%s: got %q, want no match", id, got)
		}
	}
}

// The console writing the remote form itself: the shape docs/remote-models.md
// describes, read back by every rule that treats it -- and an entry moved
// back to local keeps its hand-written fixed-port proxy while losing the
// keys the console wrote for the remote form.
func TestUpsertRemoteRoundTrip(t *testing.T) {
	s, m := tempStore(t)
	ctx := context.Background()
	spec := api.ModelSpec{ID: "mac-qwen", Name: "Mac Qwen", Description: "on the Mac",
		Endpoint: "http://192.168.1.30:8000", UpstreamName: "Qwen3-4B-MLX-4bit",
		CtxSize: 16384, TTL: 900, Group: strp("large")}
	if err := s.Upsert(ctx, spec, map[string]string{}, map[string]bool{}, ""); err != nil {
		t.Fatal(err)
	}
	out, _ := s.Raw()
	for _, want := range []string{
		"proxy: http://192.168.1.30:8000",
		"useModelName: Qwen3-4B-MLX-4bit",
		"checkEndpoint: /health",
		"sleep 3600",
		"ttl: 0",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	// No card, no container: no env for this entry, no group for it to
	// evict through.
	if strings.Contains(out, "members:\n      - mac-qwen") {
		t.Errorf("remote entry joined a group:\n%s", out)
	}
	if got := s.RemoteProxy("mac-qwen"); got != "http://192.168.1.30:8000" {
		t.Errorf("RemoteProxy: %q", got)
	}
	if pk := m.ProviderKeys(); pk["mac-qwen"] != RemoteKey {
		t.Errorf("ProviderKeys: %v", pk["mac-qwen"])
	}
	read := m.ReadSpec("mac-qwen")
	if read == nil || read.Provider != RemoteKey || read.Endpoint != "http://192.168.1.30:8000" ||
		read.UpstreamName != "Qwen3-4B-MLX-4bit" || read.Name != "Mac Qwen" {
		t.Errorf("ReadSpec = %+v", read)
	}
	// Moved back to a local server: the remote keys go, the cmd comes.
	back := api.ModelSpec{ID: "mac-qwen", Name: "Mac Qwen", ModelFile: "local.gguf",
		CtxSize: 8192, TTL: 300}
	if err := s.Upsert(ctx, back, map[string]string{}, map[string]bool{}, ""); err != nil {
		t.Fatal(err)
	}
	out, _ = s.Raw()
	if strings.Contains(out, "proxy: http://192.168.1.30:8000") || strings.Contains(out, "useModelName") {
		t.Errorf("remote keys outlived the move back:\n%s", out)
	}
	if !strings.Contains(out, "--model ${models-dir}/local.gguf") {
		t.Errorf("local cmd not written:\n%s", out)
	}
	// An ordinary local entry of the sample config is not remote.
	if got := s.RemoteProxy("small-q4"); got != "" {
		t.Errorf("local entry read as remote: %q", got)
	}
}
