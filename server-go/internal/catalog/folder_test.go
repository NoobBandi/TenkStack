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

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
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
	// gate: files are served only to this bearer token, as a gated repo's.
	gate    string
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
	if h.gate != "" && r.Header.Get("Authorization") != "Bearer "+h.gate {
		w.WriteHeader(http.StatusUnauthorized)
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
				"text_config":{"dtype":"bfloat16","max_position_embeddings":262144,"num_hidden_layers":64,"mtp_num_hidden_layers":1,
				"num_key_value_heads":4,"head_dim":256,"full_attention_interval":4}}`),
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

// A gated repository says what to do until a token that may open it is set,
// and then loads like any other.
func TestGatedFolder(t *testing.T) {
	hub := newHub()
	hub.gate = "hf_ok"
	c, _ := newCatalog(t, hub)
	token := ""
	c.Token = func() string { return token }
	ctx := context.Background()

	f, err := c.Folder(ctx, "owner/model")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(f.NeedsAccess, "設定") || f.Precision != "" {
		t.Errorf("without a token: %q, precision %q", f.NeedsAccess, f.Precision)
	}
	token = "hf_wrong"
	if f, _ := c.Folder(ctx, "owner/model"); !strings.Contains(f.NeedsAccess, "還沒有權限") {
		t.Errorf("with a token the repo refuses: %q", f.NeedsAccess)
	}
	token = "hf_ok"
	if f, _ := c.Folder(ctx, "owner/model"); f.NeedsAccess != "" || f.Precision != "bf16" || f.KVBytesPerToken == 0 {
		t.Errorf("with the token: %+v", f)
	}
	if _, err := c.StartFolder(ctx, "owner/model", ""); err != nil {
		t.Fatal(err)
	}
	if state := waitFor(t, c); state != "done" {
		t.Errorf("download with the token ended %s", state)
	}
}

func TestCoarsePrecision(t *testing.T) {
	for _, c := range []struct {
		id     string
		tags   []string
		params map[string]int64
		want   string
		gib    float64
	}{
		// As the Hub lists them for Qwen3.8-27B, Llama 3.1 and quantisations.
		{"huihui-ai/Huihui-Qwen3.8-27B-abliterated", nil, map[string]int64{"BF16": 27781427952}, "bf16", 51.75},
		{"Qwen/Qwen3.8-27B-FP8", []string{"fp8"}, map[string]int64{"BF16": 3082220272, "F8_E4M3": 24699207680}, "fp8", 28.74},
		// Packed values are left out of the size, which the listing gives.
		{"sakamakismile/Huihui-Qwen3.8-27B-abliterated-NVFP4", []string{"nvfp4", "8-bit"}, map[string]int64{"BF16": 3006172400, "U8": 24350556160}, "nvfp4", 5.6},
		// The name says NVFP4 though the tags only say 8-bit.
		{"nvidia/Llama-3.1-8B-Instruct-NVFP4", []string{"8-bit"}, nil, "nvfp4", 0},
		// bitsandbytes is its own thing, not the int4 an engine writes.
		{"unsloth/Meta-Llama-3.1-8B-Instruct-bnb-4bit", []string{"4-bit", "bitsandbytes"}, nil, "bnb", 0},
		{"RedHatAI/Meta-Llama-3.1-8B-Instruct-quantized.w4a16", nil, nil, "int4", 0},
		{"someone/model", nil, map[string]int64{"BF16": 3082220272, "F8_E4M3": 24699207680}, "fp8", 28.74},
		{"someone/model", nil, map[string]int64{"I32": 3000000000, "BF16": 1000000000}, "int4", 1.86},
	} {
		got, size := coarsePrecision(c.id, c.tags, c.params)
		if got != c.want || gib(size) != c.gib {
			t.Errorf("%s: %s %.2f GiB, want %s %.2f", c.id, got, gib(size), c.want, c.gib)
		}
	}
}

// Both formats at once come back as one list by downloads, each marked with
// the format it was found under, and a GGUF repo never offered as a folder.
func TestSearchAll(t *testing.T) {
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Query().Get("filter") {
		case "gguf":
			w.Write([]byte(`[{"id":"a/model-GGUF","downloads":50,"tags":["gguf"]},{"id":"b/small-GGUF","downloads":5,"tags":["gguf"]}]`))
		case "safetensors":
			w.Write([]byte(`[{"id":"a/model","downloads":90,"tags":["safetensors"]},{"id":"c/other-GGUF","downloads":70,"tags":["gguf","safetensors"]}]`))
		}
	}))
	defer hub.Close()
	c := New(onePlace{locations.Location{Key: locations.Primary, Path: t.TempDir()}})
	c.Hub = hub.URL
	got := c.Search(context.Background(), "model", 10, "all")
	var line []string
	for _, r := range got {
		line = append(line, fmt.Sprintf("%v:%s", r.RepoID, r.Format))
	}
	if want := "a/model:safetensors a/model-GGUF:gguf b/small-GGUF:gguf"; strings.Join(line, " ") != want {
		t.Errorf("got %v, want %s", line, want)
	}
}

func TestKindOf(t *testing.T) {
	for _, c := range []struct {
		m    map[string]any
		want string
		sure bool
	}{
		// As the Hub's search returns them, with config and gguf expanded.
		{map[string]any{"id": "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF", "gguf": map[string]any{"architecture": "qwen3moe"}}, "moe", true},
		{map[string]any{"id": "unsloth/Qwen3.8-27B-GGUF", "gguf": map[string]any{"architecture": "qwen35"}}, "dense", false},
		{map[string]any{"id": "Qwen/Qwen3.6-35B-A3B-FP8", "config": map[string]any{"model_type": "qwen3_5_moe"}}, "moe", true},
		{map[string]any{"id": "deepseek-ai/DeepSeek-V3", "config": map[string]any{"model_type": "deepseek_v3"}}, "moe", true},
		// Mixtral's GGUF says llama; its name says the rest.
		{map[string]any{"id": "TheBloke/Mixtral-8x7B-Instruct-v0.1-GGUF", "gguf": map[string]any{"architecture": "llama"}}, "moe", true},
		// Flash-Next says neither: only its config can.
		{map[string]any{"id": "unsloth/Qwen3.8-Flash-Next-GGUF", "gguf": map[string]any{"architecture": "qwen4exp"}}, "dense", false},
		// Only a vision projector's header: nothing to go on.
		{map[string]any{"id": "someone/model-GGUF", "gguf": map[string]any{"architecture": "clip"}}, "", false},
	} {
		if got, _, sure := kindOf(c.m); got != c.want || sure != c.sure {
			t.Errorf("%v: %q sure %v, want %q sure %v", c.m["id"], got, sure, c.want, c.sure)
		}
	}
}

// An architecture that only looked dense is settled by one config.json --
// the GGUF's base model's -- and remembered.
func TestConfirmKinds(t *testing.T) {
	asked := map[string]int{}
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked[r.URL.Path]++
		switch r.URL.Path {
		case "/Qwen/Qwen3.8-Flash-Next/resolve/main/config.json":
			w.Write([]byte(`{"text_config":{"num_hidden_layers":48,"num_experts":512,"num_experts_per_tok":10}}`))
		case "/Qwen/Qwen3.8-27B/resolve/main/config.json":
			w.Write([]byte(`{"text_config":{"num_hidden_layers":64}}`))
		default:
			w.WriteHeader(http.StatusUnauthorized)
		}
	}))
	defer hub.Close()
	c := New(onePlace{locations.Location{Key: locations.Primary, Path: t.TempDir()}})
	c.Hub = hub.URL
	raw := []map[string]any{
		{"id": "unsloth/Qwen3.8-Flash-Next-GGUF", "gguf": map[string]any{"architecture": "qwen4exp"},
			"tags": []any{"gguf", "base_model:Qwen/Qwen3.8-Flash-Next", "base_model:quantized:Qwen/Qwen3.8-Flash-Next"}},
		{"id": "orcarouter/Qwen3.8-Flash-Next-Uncensored-GGUF", "gguf": map[string]any{"architecture": "qwen4exp"}},
		{"id": "unsloth/Qwen3.8-27B-GGUF", "gguf": map[string]any{"architecture": "qwen35"},
			"tags": []any{"base_model:quantized:Qwen/Qwen3.8-27B"}},
		{"id": "meta-llama-quants/Llama-GGUF", "gguf": map[string]any{"architecture": "llama"},
			"tags": []any{"base_model:quantized:meta-llama/Llama-3.1-8B"}},
		// The Hub read only its projector's header: its base model says.
		{"id": "cdiamond/Qwen3.8-27B-iMatrix-NVFP4-MTP-GGUF", "gguf": map[string]any{"architecture": "clip"},
			"tags": []any{"base_model:quantized:Qwen/Qwen3.8-27B"}},
	}
	out := make([]api.CatalogRepo, len(raw))
	for i, m := range raw {
		out[i] = api.CatalogRepo{RepoID: m["id"]}
		out[i].Kind, _, _ = kindOf(m)
	}
	c.confirmKinds(context.Background(), raw, out, "gguf")
	var got []string
	for _, r := range out {
		got = append(got, r.Kind)
	}
	// The gated Llama base keeps its guess.
	if want := "moe moe dense dense dense"; strings.Join(got, " ") != want {
		t.Errorf("kinds %v, want %s", got, want)
	}
	c.confirmKinds(context.Background(), raw, out, "gguf")
	if asked["/Qwen/Qwen3.8-Flash-Next/resolve/main/config.json"] != 1 {
		t.Errorf("asked about qwen4exp %d times", asked["/Qwen/Qwen3.8-Flash-Next/resolve/main/config.json"])
	}
}
