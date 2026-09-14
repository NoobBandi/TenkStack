package llamaswap

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func load(t *testing.T) ([]byte, *Config) {
	t.Helper()
	src, err := os.ReadFile(filepath.Join("testdata", "sample.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	c, err := Parse(src)
	if err != nil {
		t.Fatal(err)
	}
	return src, c
}

func TestRoundTripIsByteIdentical(t *testing.T) {
	src, c := load(t)
	out, err := c.Bytes()
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != string(src) {
		t.Fatalf("round trip changed the file:\n--- want\n%s\n--- got\n%s", src, out)
	}
}

func TestEditKeepsEverythingElse(t *testing.T) {
	src, c := load(t)
	models := c.Root().Map("models")

	e := models.Map("big-q6")
	e.Set("name", Str("Big Q6 (edited)"))
	e.Set("cmd", Literal("${llama-sycl}\n--model ${models-dir}/x.gguf\n"))
	e.Set("ttl", Int(900))

	n := models.EnsureMap("new-model")
	n.Set("name", Str("New"))
	n.Set("description", Str(""))
	n.Set("cmd", Literal("${llama-sycl}\n--model ${models-dir}/new.gguf\n"))
	n.Set("ttl", Int(0))

	if !models.Delete("small-q4") {
		t.Fatal("small-q4 not deleted")
	}
	large := c.Root().Map("groups").Map("large")
	large.Set("members", Seq("big-q6", "new-model"))

	out, err := c.Bytes()
	if err != nil {
		t.Fatal(err)
	}
	got := string(out)

	for _, want := range []string{
		"# llama-swap on one card, shared with ComfyUI.\n#\n",
		"healthCheckTimeout: 900\n\nlogLevel: info\n",
		"  # Owns the SYCL environment; every model flag comes from cmd.\n",
		"# Why every entry carries --parallel 1: one slot with the whole window.\n\nmodels:\n",
		"    name: Big Q6 (edited)\n",
		"    description: 'quoted · with unicode · 256K'\n",
		"    cmd: |\n      ${llama-sycl}\n      --model ${models-dir}/x.gguf\n    ttl: 900\n",
		"  new-model:\n    name: New\n    description: ''\n    cmd: |\n",
		"  # Leaves room for ComfyUI alongside; members may be resident together.\n",
		"    members:\n      - big-q6\n      - new-model\n",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	if strings.Contains(got, "small-q4:") || strings.Contains(got, "aliases") {
		t.Errorf("deleted entry survived:\n%s", got)
	}

	// The edited file must still be plain YAML with the same shape.
	var plain map[string]any
	if err := yaml.Unmarshal(out, &plain); err != nil {
		t.Fatal(err)
	}
	m := plain["models"].(map[string]any)
	if m["new-model"].(map[string]any)["description"] != "" {
		t.Errorf("empty description did not read back as a string")
	}
	if len(m) != 2 {
		t.Errorf("want 2 models, got %d", len(m))
	}
	_ = src
}

func TestBlankLinesInsideBlockScalarAreContent(t *testing.T) {
	_, c := load(t)
	cmd := Scalar(c.Root().Map("models").Map("big-q6").Get("cmd"))
	want := "${llama-sycl}\n--model ${models-dir}/big-q6.gguf\n\n--ctx-size 262144\n# inside the block this is content, not a comment\n"
	if cmd != want {
		t.Fatalf("cmd = %q, want %q", cmd, want)
	}
}

func TestEmptyFile(t *testing.T) {
	c, err := Parse(nil)
	if err != nil {
		t.Fatal(err)
	}
	c.Root().EnsureMap("models")
	out, err := c.Bytes()
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != "models: {}\n" {
		t.Fatalf("got %q", out)
	}
}
