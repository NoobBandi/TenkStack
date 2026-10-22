package registry

import (
	"slices"
	"testing"
	"time"
)

func TestParse(t *testing.T) {
	for in, want := range map[string]Ref{
		"vllm/vllm-openai-xpu:v0.31.0":            {"docker.io", "vllm/vllm-openai-xpu", "v0.31.0"},
		"ghcr.io/ggml-org/llama.cpp:server-intel": {"ghcr.io", "ggml-org/llama.cpp", "server-intel"},
		"ubuntu":                        {"docker.io", "library/ubuntu", "latest"},
		"localhost:5000/x:1@sha256:abc": {"localhost:5000", "x", "1"},
		"vllm/vllm-openai-xpu@sha256:95ac815038c4b35": {"docker.io", "vllm/vllm-openai-xpu", "latest"},
	} {
		if got := Parse(in); got != want {
			t.Errorf("%s: %+v", in, got)
		}
	}
	if Parse("ubuntu:24.04").Name() != "ubuntu:24.04" || Parse("ghcr.io/a/b:c").Name() != "ghcr.io/a/b:c" {
		t.Error("Name")
	}
	if !SameRepo("vllm/vllm-openai-xpu:v0.31.0", "docker.io/vllm/vllm-openai-xpu:nightly") || SameRepo("a/b:1", "a/c:1") {
		t.Error("SameRepo")
	}
}

func TestKinds(t *testing.T) {
	for tag, want := range map[string]string{
		"v0.31.0": Release, "0.5.4": Release, "v0.32.0rc1": Release,
		"server-intel-b11804": Build, "nightly-39983a5e7a5a575a7829f5d5ada50a33d9337ec1": Nightly,
		"nightly": Rolling, "latest": Rolling, "server-intel": Rolling, "cu129-nightly": Rolling, "nightly-x86_64": Rolling,
	} {
		if got := Kind(tag); got != want {
			t.Errorf("%s: %s, want %s", tag, got, want)
		}
	}
}

// What the two registries this machine uses gave, cut down.
func TestOffered(t *testing.T) {
	day := func(d int) time.Time { return time.Date(2026, 10, d, 5, 0, 0, 0, time.UTC) }
	hub := []Tag{
		{Name: "nightly-df6603f0583375f244d1ac6d36265462b7490392", Updated: day(22)},
		{Name: "nightly", Updated: day(22)}, {Name: "nightly-x86_64", Updated: day(22)},
		{Name: "nightly-39983a5e7a5a575a7829f5d5ada50a33d9337ec1", Updated: day(17)},
		{Name: "v0.31.0", Updated: day(5)}, {Name: "v0.32.0rc1", Updated: day(20)},
		{Name: "v0.30.0", Updated: day(1)}, {Name: "v0.29.1", Updated: day(1)}, {Name: "v0.29.0", Updated: day(1)},
	}
	names := func(tags []Tag) []string {
		var out []string
		for _, t := range tags {
			out = append(out, t.Name)
		}
		return out
	}
	got := names(Offered(hub, []string{"nightly"}, 2))
	want := []string{"v0.31.0", "v0.30.0", "nightly-df6603f0583375f244d1ac6d36265462b7490392", "nightly-39983a5e7a5a575a7829f5d5ada50a33d9337ec1"}
	if !slices.Equal(got, want) {
		t.Errorf("hub: %v", got)
	}
	if got := names(Newer(hub, "v0.30.0")); !slices.Equal(got, []string{"v0.31.0"}) {
		t.Errorf("newer than 0.30: %v", got)
	}
	if Newer(hub, "nightly") != nil {
		t.Error("a rolling tag has no newer releases")
	}
	ghcr := []Tag{{Name: "server-intel"}, {Name: "server-intel-b4726"}, {Name: "server-intel-b11804"},
		{Name: "server-intel-b11783"}, {Name: "server-musa-b11804"}, {Name: "full-intel-b11804"}}
	if got := names(Offered(ghcr, []string{"server-intel"}, 2)); !slices.Equal(got, []string{"server-intel-b11804", "server-intel-b11783"}) {
		t.Errorf("ghcr: %v", got)
	}
}
