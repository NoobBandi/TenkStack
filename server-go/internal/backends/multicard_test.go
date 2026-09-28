package backends

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/NoobBandi/TenkStack/server-go/internal/providers"
)

// runLauncher runs a launcher with docker replaced by a stub that prints
// its arguments one per line, and returns them.
func runLauncher(t *testing.T, script, selector string) []string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "launcher.sh")
	os.WriteFile(path, []byte(script), 0o755)
	bin := filepath.Join(dir, "bin")
	os.MkdirAll(bin, 0o755)
	os.WriteFile(filepath.Join(bin, "docker"), []byte("#!/usr/bin/env bash\nprintf '%s\\n' \"$@\"\n"), 0o755)
	cmd := exec.Command("bash", path, "--model", "/m")
	cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "ONEAPI_DEVICE_SELECTOR="+selector)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("launcher failed: %v\n%s", err, out)
	}
	return strings.Split(strings.TrimSpace(string(out)), "\n")
}

func argAfter(args []string, flag string) string {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

// The Intel vLLM launcher gives an entry on several cards its own worker
// affinity, oneCCL settings, privileges and kernel cache, and one on a single
// card none of it.
func TestMultiCardLauncher(t *testing.T) {
	script := WrapperText(*providers.Get(providers.VLLM), "intel", "/models", "")

	one := runLauncher(t, script, "level_zero:1")
	joined := strings.Join(one, " ")
	for _, absent := range []string{"--ipc", "SYS_PTRACE", "--entrypoint", "TENKSTACK_MULTI_CARD=1", "CCL_SYCL"} {
		if strings.Contains(joined, absent) {
			t.Errorf("one card got %q: %v", absent, one)
		}
	}
	if !strings.Contains(joined, "/cache/vllm-intel:/root/.cache/vllm") {
		t.Errorf("one card's kernel cache: %v", one)
	}

	two := runLauncher(t, script, "level_zero:0,1")
	joined = strings.Join(two, " ")
	for _, want := range []string{"--ipc host", "--cap-add SYS_PTRACE", "TENKSTACK_MULTI_CARD=1",
		"CCL_SYCL_ALLREDUCE_SIMPLE_THRESHOLD=4294967296", "/cache/vllm-intel-multi:/root/.cache/vllm",
		"--entrypoint bash " + providers.Get(providers.VLLM).Builds["intel"].Image} {
		if !strings.Contains(joined, want) {
			t.Errorf("two cards lack %q: %v", want, two)
		}
	}
	run := argAfter(two, "-c")
	if !strings.HasPrefix(run, "python3 /tenkstack/vllm-intel-multi-card.py && ") || !strings.HasSuffix(run, `exec vllm serve "$@"`) {
		t.Errorf("setup then the image's own start: %q", run)
	}
	if two[len(two)-3] != "--" || two[len(two)-2] != "--model" {
		t.Errorf("llama-swap's flags follow the entrypoint's --: %v", two[len(two)-4:])
	}

	for _, p := range []string{providers.LlamaCpp} {
		if s := WrapperText(*providers.Get(p), "intel", "/models", ""); strings.Contains(s, "MULTI=") {
			t.Errorf("%s has no multi-card settings but its launcher does", p)
		}
	}
	if s := WrapperText(*providers.Get(providers.VLLM), "nvidia", "/models", ""); strings.Contains(s, "MULTI=") {
		t.Error("the multi-card settings are Intel's build's, not NVIDIA's")
	}
}

func TestUpgradeMultiCard(t *testing.T) {
	p := *providers.Get(providers.VLLM)
	dir := t.TempDir()
	in := &Installer{ScriptDir: dir, ModelsDir: "/models"}
	path := filepath.Join(dir, p.ScriptName("intel"))
	setup := filepath.Join(dir, SetupName(p, "intel"))

	// Written before multi-card settings, image since updated: rewritten, tag kept.
	old := strings.Replace(wrapperText(p, "intel", "/models", "", false), p.Builds["intel"].Image, "intel/llm-scaler-vllm:older", 1)
	os.WriteFile(path, []byte(old), 0o755)
	changed, err := in.UpgradeMultiCard()
	if err != nil || len(changed) != 1 {
		t.Fatalf("changed %v, %v", changed, err)
	}
	now, _ := os.ReadFile(path)
	if !strings.Contains(string(now), "MULTI=()") || !strings.Contains(string(now), "intel/llm-scaler-vllm:older") {
		t.Errorf("upgraded launcher:\n%s", now)
	}
	if got, _ := os.ReadFile(setup); string(got) != string(p.Builds["intel"].MultiCard.Script()) {
		t.Error("the setup script was not written beside it")
	}

	// Already upgraded: only the setup script is refreshed.
	os.WriteFile(setup, []byte("stale"), 0o644)
	if changed, _ := in.UpgradeMultiCard(); len(changed) != 0 {
		t.Errorf("rewrote an upgraded launcher: %v", changed)
	}
	if got, _ := os.ReadFile(setup); string(got) == "stale" {
		t.Error("the setup script was not refreshed")
	}

	// Edited by hand: left alone.
	edited := old + "# my change\n"
	os.WriteFile(path, []byte(edited), 0o755)
	if changed, _ := in.UpgradeMultiCard(); len(changed) != 0 {
		t.Errorf("rewrote an edited launcher: %v", changed)
	}
	if got, _ := os.ReadFile(path); string(got) != edited {
		t.Error("an edited launcher changed")
	}
}
