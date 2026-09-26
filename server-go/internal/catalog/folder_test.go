package catalog

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/NoobBandi/TenkStack/server-go/internal/locations"
)

type onePlace struct{ loc locations.Location }

func (p onePlace) Locations() []locations.Location           { return []locations.Location{p.loc} }
func (p onePlace) DefaultLocation(string) locations.Location { return p.loc }

// fakeHub serves a repository the way the Hub does: a listing with LFS
// digests, and files that honour Range. corrupt names a file whose bytes
// differ from its digest.
type fakeHub struct {
	files   map[string][]byte
	lfs     map[string]bool
	corrupt string
	mu      sync.Mutex
	fetched map[string]int
}

func (h *fakeHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	const repo = "/owner/model"
	if strings.HasPrefix(r.URL.Path, "/api/models"+repo) {
		var siblings []map[string]any
		for name, body := range h.files {
			s := map[string]any{"rfilename": name, "size": len(body)}
			if h.lfs[name] {
				sum := sha256.Sum256(body)
				s["lfs"] = map[string]any{"sha256": hex.EncodeToString(sum[:]), "size": len(body)}
			}
			siblings = append(siblings, s)
		}
		json.NewEncoder(w).Encode(map[string]any{"siblings": siblings})
		return
	}
	name := strings.TrimPrefix(r.URL.Path, repo+"/resolve/main/")
	body, ok := h.files[name]
	if !ok {
		http.NotFound(w, r)
		return
	}
	if name == h.corrupt {
		body = append([]byte{}, body...)
		body[0] ^= 0xff
	}
	h.mu.Lock()
	h.fetched[name]++
	h.mu.Unlock()
	start, end := 0, len(body)-1
	if rg := r.Header.Get("Range"); rg != "" {
		fmt.Sscanf(rg, "bytes=%d-%d", &start, &end)
		if end >= len(body) {
			end = len(body) - 1
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(body)))
		w.Header().Set("Content-Length", strconv.Itoa(end-start+1))
		w.WriteHeader(http.StatusPartialContent)
	}
	w.Write(body[start : end+1])
}

func newHub() *fakeHub {
	weights := make([]byte, 3<<20)
	for i := range weights {
		weights[i] = byte(i * 7)
	}
	return &fakeHub{
		files: map[string][]byte{
			"config.json": []byte(`{"architectures":["Qwen3_5ForConditionalGeneration"],"vision_config":{"depth":27},
				"text_config":{"dtype":"bfloat16","max_position_embeddings":262144,"num_hidden_layers":64,"mtp_num_hidden_layers":1}}`),
			"tokenizer.json":                   []byte(`{"version":"1.0"}`),
			"chat_template.jinja":              []byte("{{ messages }}"),
			"model-00001-of-00002.safetensors": weights,
			"model-00002-of-00002.safetensors": weights[:1<<20],
			"pytorch_model.bin":                []byte("old copy"),
			"original/consolidated.00.pth":     []byte("checkpoint"),
			"README.md":                        []byte("# model"),
			"images/card.png":                  []byte("png"),
		},
		lfs:     map[string]bool{"model-00001-of-00002.safetensors": true, "model-00002-of-00002.safetensors": true},
		fetched: map[string]int{},
	}
}

func newCatalog(t *testing.T, hub *fakeHub) (*Catalog, string) {
	t.Helper()
	srv := httptest.NewServer(hub)
	t.Cleanup(srv.Close)
	dir := t.TempDir()
	c := New(onePlace{locations.Location{Key: locations.Primary, Path: dir}})
	c.Hub = srv.URL
	return c, dir
}

func waitFor(t *testing.T, c *Catalog) string {
	t.Helper()
	for i := 0; i < 500; i++ {
		for _, d := range c.Status() {
			if d.Kind == "folder" && (d.State == "done" || d.State == "error" || d.State == "cancelled") {
				if d.Error != nil {
					return d.State + ": " + *d.Error
				}
				return d.State
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the download never ended")
	return ""
}

func TestFolderDownload(t *testing.T) {
	hub := newHub()
	c, dir := newCatalog(t, hub)
	ctx := context.Background()

	f, err := c.Folder(ctx, "owner/model")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, file := range f.Files {
		names = append(names, file.Name)
	}
	want := "chat_template.jinja config.json model-00001-of-00002.safetensors model-00002-of-00002.safetensors tokenizer.json"
	if strings.Join(names, " ") != want {
		t.Errorf("files %v, want %s", names, want)
	}
	if !f.Loadable || f.Precision != "bf16" || !f.Vision || !f.MTP || f.ContextLength != 262144 || f.OnDisk || f.PresentBytes != 0 {
		t.Errorf("folder %+v", f)
	}
	if f.SizeBytes != 4<<20+int64(len(hub.files["config.json"])+len(hub.files["tokenizer.json"])+len(hub.files["chat_template.jinja"])) {
		t.Errorf("size %d", f.SizeBytes)
	}

	if _, err := c.StartFolder(ctx, "owner/model", ""); err != nil {
		t.Fatal(err)
	}
	if state := waitFor(t, c); state != "done" {
		t.Fatalf("ended %s", state)
	}
	for _, name := range names {
		got, err := os.ReadFile(filepath.Join(dir, "owner", "model", name))
		if err != nil || string(got) != string(hub.files[name]) {
			t.Errorf("%s on disk: %v", name, err)
		}
	}
	for _, left := range []string{"README.md", "pytorch_model.bin", "original"} {
		if _, err := os.Stat(filepath.Join(dir, "owner", "model", left)); err == nil {
			t.Errorf("%s was downloaded", left)
		}
	}
	if f, _ := c.Folder(ctx, "owner/model"); !f.OnDisk || f.LocalPath != "owner/model" {
		t.Errorf("after the download: on disk %v at %q", f.OnDisk, f.LocalPath)
	}
}

// A file whose bytes do not match the Hub's digest is refused and removed,
// not kept as the model.
func TestFolderDownloadRefusesACorruptFile(t *testing.T) {
	hub := newHub()
	hub.corrupt = "model-00002-of-00002.safetensors"
	c, dir := newCatalog(t, hub)
	if _, err := c.StartFolder(context.Background(), "owner/model", ""); err != nil {
		t.Fatal(err)
	}
	state := waitFor(t, c)
	if !strings.HasPrefix(state, "error") || !strings.Contains(state, "校驗不符") {
		t.Fatalf("ended %s", state)
	}
	base := filepath.Join(dir, "owner", "model", hub.corrupt)
	for _, p := range []string{base, base + ".part"} {
		if _, err := os.Stat(p); err == nil {
			t.Errorf("%s left behind", filepath.Base(p))
		}
	}
}

// A file already there at its size is kept rather than fetched again.
func TestFolderDownloadKeepsWhatIsThere(t *testing.T) {
	hub := newHub()
	c, dir := newCatalog(t, hub)
	name := "model-00001-of-00002.safetensors"
	os.MkdirAll(filepath.Join(dir, "owner", "model"), 0o755)
	os.WriteFile(filepath.Join(dir, "owner", "model", name), hub.files[name], 0o644)
	if _, err := c.StartFolder(context.Background(), "owner/model", ""); err != nil {
		t.Fatal(err)
	}
	if state := waitFor(t, c); state != "done" {
		t.Fatalf("ended %s", state)
	}
	if hub.fetched[name] != 0 {
		t.Errorf("%s fetched %d times though it was there", name, hub.fetched[name])
	}
	for _, d := range c.Status() {
		if d.Files != 5 || d.FilesDone != 5 || d.Percent != 100 {
			t.Errorf("status %+v", d)
		}
	}
}

// A safetensors search leaves out what a server engine cannot load as a
// folder: GGUF repositories and MLX exports.
func TestNotForServer(t *testing.T) {
	for id, tags := range map[string][]any{
		"unsloth/Qwen3.8-27B-GGUF":          {"gguf"},
		"someone/Qwen3.8-27B-mlx-4Bit":      {"safetensors"},
		"root4k/Qwen3.8-27B-oQ4e-mtp":       {"mlx", "safetensors"},
		"huihui-ai/Huihui-Qwen3.8-27B-abli": nil,
	} {
		got := notForServer(map[string]any{"id": id, "tags": tags})
		if want := id != "huihui-ai/Huihui-Qwen3.8-27B-abli"; got != want {
			t.Errorf("%s: %v, want %v", id, got, want)
		}
	}
}
