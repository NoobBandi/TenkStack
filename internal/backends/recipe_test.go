package backends

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/NoobBandi/TenkStack/internal/api"
	"github.com/NoobBandi/TenkStack/internal/providers"
)

type fakeImages struct{ pulled []string }

func (f *fakeImages) ImageSizes(context.Context) map[string]string { return map[string]string{} }
func (f *fakeImages) Pull(_ context.Context, image string, _ api.Progress) bool {
	f.pulled = append(f.pulled, image)
	return true
}
func (f *fakeImages) RemoveImage(context.Context, string) bool { return true }

type noLaunchers struct{}

func (noLaunchers) LlamaLaunchers() []string { return nil }

func recipeInstaller(t *testing.T) (*Installer, *fakeImages) {
	images := &fakeImages{}
	return &Installer{Probe: New(noLaunchers{}), Images: images, ScriptDir: t.TempDir(), ModelsDir: "/models"}, images
}

// What the vLLM Intel launcher looked like on the b2 image: another tag, a
// start line that sourced oneAPI, and the note of its day.
func b2Launcher(current string) string {
	old := imageLine.ReplaceAllString(current, `IMAGE="${VLLM_IMAGE:-intel/llm-scaler-vllm:0.26.0-b2}"`)
	old = regexp.MustCompile(`(?m)^(\s*RUN=\(--entrypoint bash "\$IMAGE" -c ')python3 (\S+) && exec vllm serve "\$@"(' --\))$`).
		ReplaceAllString(old, `${1}python3 ${2} && source /opt/intel/oneapi/setvars.sh --force >/dev/null && source /opt/intel/oneapi/ccl/2021.15/env/vars.sh --force && exec vllm serve "$@"${3}`)
	return strings.Replace(old, "Intel's compute-runtime pins", "this image's compute-runtime (26.14) pins", 1)
}

func TestRecipe(t *testing.T) {
	in, _ := recipeInstaller(t)
	p := *providers.Get(providers.VLLM)
	path := filepath.Join(in.ScriptDir, p.ScriptName("intel"))
	current := WrapperText(p, "intel", "/models", "")
	recommended := p.Builds["intel"].Image

	check := func(name, text, wantState string) {
		t.Helper()
		os.WriteFile(path, []byte(text), 0o755)
		state, _, rec := in.Recipe(p, "intel")
		if state != wantState {
			t.Errorf("%s: state %q, want %q", name, state, wantState)
		}
		if wantState != RecipeEdited && rec != recommended {
			t.Errorf("%s: recommended %q, want %q", name, rec, recommended)
		}
	}
	check("as written now", current, RecipeCurrent)
	check("another tag", imageLine.ReplaceAllString(current, `IMAGE="${VLLM_IMAGE:-vllm/vllm-openai-xpu:v0.29.0}"`), RecipeOutdated)
	old := b2Launcher(current)
	if old == current || !strings.Contains(old, "setvars.sh") {
		t.Fatal("the b2 launcher was not reconstructed")
	}
	check("the b2 launcher", old, RecipeOutdated)
	check("an extra flag by hand", strings.Replace(current, "--shm-size 16g", "--shm-size 32g", 1), RecipeEdited)
	check("a changed start by hand", strings.Replace(old, "exec vllm serve", "exec my-vllm serve", 1), RecipeEdited)

	l := *providers.Get(providers.LlamaCpp)
	if l.Fallback != nil {
		os.WriteFile(filepath.Join(in.ScriptDir, l.ScriptName("intel")), []byte(WrapperText(l, "intel", "/models", "vulkan")), 0o755)
		if state, variant, _ := in.Recipe(l, "intel"); state != RecipeCurrent || variant != "vulkan" {
			t.Errorf("the Vulkan variant is current as itself: %q %q", state, variant)
		}
	}
}

func TestUpgrade(t *testing.T) {
	in, images := recipeInstaller(t)
	p := *providers.Get(providers.VLLM)
	path := filepath.Join(in.ScriptDir, p.ScriptName("intel"))
	current := WrapperText(p, "intel", "/models", "")

	os.WriteFile(path, []byte(strings.Replace(current, "--shm-size 16g", "--shm-size 32g", 1)), 0o750)
	if _, err := in.Upgrade(context.Background(), p.Key, "intel"); err == nil {
		t.Fatal("a hand-edited launcher is refused")
	}

	os.WriteFile(path, []byte(b2Launcher(current)), 0o750)
	if _, err := in.Upgrade(context.Background(), p.Key, "intel"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 200; i++ {
		if st := in.install(p, "intel"); st != nil && (st.State == "done" || st.State == "error") {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if st := in.install(p, "intel"); st == nil || st.State != "done" {
		t.Fatalf("upgrade did not finish: %+v", st)
	}
	got, _ := os.ReadFile(path)
	if string(got) != current {
		t.Errorf("the launcher is not what the record writes now:\n%s", got)
	}
	if st, _ := os.Stat(path); st.Mode().Perm() != 0o750 {
		t.Errorf("its mode changed: %v", st.Mode().Perm())
	}
	if len(images.pulled) != 1 || images.pulled[0] != p.Builds["intel"].Image {
		t.Errorf("pulled %v", images.pulled)
	}
	if _, err := os.Stat(filepath.Join(in.ScriptDir, SetupName(p, "intel"))); err != nil {
		t.Error("the multi-card setup script is written beside it")
	}
	if _, err := in.Upgrade(context.Background(), p.Key, "intel"); err == nil {
		t.Error("an up-to-date launcher has nothing to upgrade")
	}
}
