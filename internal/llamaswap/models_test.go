package llamaswap

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/NoobBandi/TenkStack/internal/api"
)

func tempStore(t *testing.T) (*Store, *Models) {
	t.Helper()
	dir := t.TempDir()
	src, _ := os.ReadFile(filepath.Join("testdata", "sample.yaml"))
	path := filepath.Join(dir, "config.yaml")
	os.WriteFile(path, src, 0o644)
	s := NewStore(path)
	s.SkipVerdict = true
	return s, &Models{Store: s, Dir: filepath.Join(dir, "models")}
}

func strp(s string) *string { return &s }

func TestUpsertMergesAndSyncsGroups(t *testing.T) {
	s, m := tempStore(t)
	ctx := context.Background()
	spec := api.ModelSpec{ID: "small-q4", Name: "Small", Description: "d", ModelFile: "small-q4.gguf",
		CtxSize: 65536, NGpuLayers: 99, TTL: 60, Group: strp("small"),
		Sampling: map[string]float64{"temperature": 0.6, "top_k": 20}, Extra: "--flash-attn on\n"}
	if err := s.Upsert(ctx, spec, map[string]string{"ONEAPI_DEVICE_SELECTOR": "level_zero:1"},
		map[string]bool{"ONEAPI_DEVICE_SELECTOR": true}, ""); err != nil {
		t.Fatal(err)
	}
	out, _ := s.Raw()
	for _, want := range []string{
		"    aliases:\n      - small\n", // an unknown key survives
		"    cmd: |\n      ${llama-sycl}\n      --model ${models-dir}/small-q4.gguf\n", // launcher kept
		"      --ctx-size 65536\n      --jinja\n      --temperature 0.6\n      --top-k 20\n      --flash-attn on\n",
		"    ttl: 60\n",
		"    env:\n      - ONEAPI_DEVICE_SELECTOR=level_zero:1\n",
		"  small:\n    swap: false\n    exclusive: false\n    members:\n      - small-q4\n",
		"    members:\n      - big-q6\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	read := m.ReadSpec("small-q4")
	if read == nil || read.CtxSize != 65536 || read.Group == nil || *read.Group != "small" ||
		read.Extra != "--flash-attn on" || read.Sampling["top_k"] != 20 || read.Env["ONEAPI_DEVICE_SELECTOR"] != "level_zero:1" {
		t.Errorf("ReadSpec = %+v", read)
	}
}

func TestDeleteRemovesEntryAndMembership(t *testing.T) {
	s, m := tempStore(t)
	res, err := m.Delete(context.Background(), "big-q6", false)
	if err != nil || res == nil || !res.OK {
		t.Fatalf("delete: %v %+v", err, res)
	}
	out, _ := s.Raw()
	if strings.Contains(out, "big-q6") {
		t.Errorf("entry survived:\n%s", out)
	}
	if !strings.Contains(out, "    members:\n      - small-q4\n") {
		t.Errorf("group not rebuilt:\n%s", out)
	}
	if res, _ := m.Delete(context.Background(), "nope", false); res != nil {
		t.Error("deleting a missing model reported success")
	}
}

func TestFilesInCmd(t *testing.T) {
	got := filesInCmd("--model ${models-dir}/a/b/w.gguf --mmproj ${models-dir}/a/b/mmproj.gguf -md /elsewhere/draft.gguf")
	want := []string{"a/b/mmproj.gguf", "a/b/w.gguf", "draft.gguf"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("files = %v", got)
	}
	r := rolesInCmd("--model x.gguf --mmproj x.gguf")
	if r["x.gguf"] != "weights" {
		t.Errorf("role = %v", r)
	}
}
