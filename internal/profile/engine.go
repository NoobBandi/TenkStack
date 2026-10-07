package profile

import (
	"path/filepath"
	"regexp"
	"strings"

	"github.com/NoobBandi/TenkStack/internal/schema"
)

// Engine keys as the workshop knows them.
const (
	LlamaCpp = "llamacpp"
	VLLM     = "vllm"
	SGLang   = "sglang"
	Strata   = "strata"
	Other    = "other"
)

// Launcher is what starts an entry's engine: the macro at the head of its
// cmd and the program it names, or a program written there directly.
type Launcher struct {
	Macro string // "vllm-intel"; "" when the cmd starts with a path
	Path  string // the program, macro expanded
}

// LauncherOf reads the launcher off a split cmd.
func LauncherOf(args []string, macros map[string]string) Launcher {
	if len(args) == 0 {
		return Launcher{}
	}
	head := args[0]
	if m := macroRef.FindStringSubmatch(head); m != nil && m[0] == head {
		return Launcher{Macro: m[1], Path: macros[m[1]]}
	}
	l := Launcher{Path: Expand(head, macros)}
	// python -m vllm.entrypoints.openai.api_server, python -m sglang.launch_server
	// (llama-server's own -m is its model, not a module.)
	if len(args) > 2 && args[1] == "-m" && strings.HasPrefix(filepath.Base(l.Path), "python") {
		l.Path = args[2]
	}
	return l
}

// names is what a launcher is called, for guessing what it runs: its
// macro, its file name and the directory it is in (~/ai/strata-sycl/
// llama-swap-serve.sh is Strata's), never more of the path, where a home
// directory's name could say anything. llama-swap's own name is taken
// out: a script beside its config is not llama.cpp for being there.
func (l Launcher) names() string {
	p := filepath.ToSlash(l.Path)
	parts := []string{l.Macro, filepath.Base(p), filepath.Base(filepath.Dir(p))}
	return strings.ReplaceAll(strings.ToLower(strings.Join(parts, " ")), "llama-swap", "")
}

// EngineKey is which engine an entry runs. registered is the engine
// internal/providers resolved the launcher's macro to, "" when it resolved
// none; that is authoritative. Otherwise the launcher's name decides, and
// a macro nobody claims is llama.cpp, as the console has always treated a
// natively built llama-server it was pointed at (llamaswap.ProviderOf).
// The Strata entry runs a script in Strata's checkout, which its name
// gives away. Anything else is "other": an engine the workshop has no
// recipes for is better unnamed than misnamed.
func EngineKey(l Launcher, registered string) string {
	switch registered {
	case LlamaCpp, VLLM, SGLang:
		return registered
	case "":
	default:
		return Other
	}
	names := l.names()
	for _, k := range []struct{ mark, key string }{
		{"strata", Strata}, {"sglang", SGLang}, {"vllm", VLLM}, {"llama", LlamaCpp},
	} {
		if strings.Contains(names, k.mark) {
			return k.key
		}
	}
	if l.Macro != "" {
		return LlamaCpp
	}
	return Other
}

// VendorOf is whose cards an engine runs on: registered is the vendor the
// launcher's macro resolved to; otherwise the launcher's name may say
// (llama-sycl, strata-sycl), and "" means any.
func VendorOf(l Launcher, registered string) string {
	if registered != "" {
		return registered
	}
	names := l.names()
	for _, k := range []struct{ mark, vendor string }{
		{"sycl", "intel"}, {"xpu", "intel"}, {"intel", "intel"},
		{"cuda", "nvidia"}, {"nvidia", "nvidia"},
		{"rocm", "amd"}, {"hip", "amd"},
	} {
		if strings.Contains(names, k.mark) {
			return k.vendor
		}
	}
	return ""
}

// The image a console-written launcher runs, overridable from the entry:
// IMAGE="${VLLM_IMAGE:-vllm/vllm-openai-xpu:v0.30.0}", or a plain
// IMAGE=… in a hand-written one.
var (
	imageDefault = regexp.MustCompile(`(?m)^\s*IMAGE="?\$\{[A-Z_]+_IMAGE:-([^}"]+)\}"?\s*$`)
	imagePlain   = regexp.MustCompile(`(?m)^\s*IMAGE="?([^"\s$]+)"?\s*$`)
)

// ImageIn is the container image an entry runs: the entry's own
// <PREFIX>_IMAGE when it sets one, else the launcher script's default.
// "" for a launcher that runs no container.
func ImageIn(script, envPrefix string, env map[string]string) string {
	if envPrefix != "" {
		if v := strings.TrimSpace(env[envPrefix+"_IMAGE"]); v != "" {
			return v
		}
	}
	if m := imageDefault.FindStringSubmatch(script); m != nil {
		return m[1]
	}
	if m := imagePlain.FindStringSubmatch(script); m != nil {
		return m[1]
	}
	return ""
}

// EngineFacts are what the console found out about the engine an entry
// runs, each optional.
type EngineFacts struct {
	// Image is the container image as the launcher names it (repo:tag).
	Image string
	// RepoDigests and Labels are that image's, from docker on this machine.
	RepoDigests []string
	Labels      map[string]string
	// Site is the engine's project URL in the registry: an image's version
	// label is believed only when the image says it comes from there, since
	// labels inherited from a base image name Ubuntu's or Intel's release.
	Site string
	// Reported is what the engine said of itself: llama-server's
	// build_info or --version, vLLM's /version, a checkout's git describe.
	Reported string
}

// Engine is the engine an entry runs, as the workshop names it. The
// version is, in order of trust: what the engine reported, the image's own
// version label, the image's tag ("v0.30.0" -> "0.30.0",
// "server-intel-b11176" -> "b11176"; a tag like "latest" says nothing and
// gives ""). llama.cpp versions are its release numbers, b11176, which its
// builds, images and props all carry. The image is pinned by digest when
// docker knows it, since a tag such as server-intel moves.
func Engine(key string, f EngineFacts) schema.EngineRef {
	out := schema.EngineRef{Key: key}
	norm := plainVersion
	if key == LlamaCpp {
		norm = LlamaBuild
	}
	switch {
	case strings.TrimSpace(f.Reported) != "":
		out.Version = norm(f.Reported)
	case f.Labels["org.opencontainers.image.version"] != "" && f.Site != "" && sameSite(f.Labels["org.opencontainers.image.source"], f.Site):
		out.Version = norm(f.Labels["org.opencontainers.image.version"])
	case f.Image != "":
		out.Version = tagVersion(f.Image)
	}
	if f.Image != "" {
		out.Image = Digest(f.Image, f.RepoDigests)
	}
	return out
}

func sameSite(a, b string) bool {
	trim := func(s string) string {
		s = strings.ToLower(strings.TrimSpace(s))
		return strings.TrimSuffix(strings.TrimSuffix(s, "/"), ".git")
	}
	return a != "" && trim(a) == trim(b)
}

// Digest is image pinned to the content docker has for it: repo@sha256:…,
// preferring the digest recorded under the image's own repository.
func Digest(image string, repoDigests []string) string {
	if strings.Contains(image, "@sha256:") || len(repoDigests) == 0 {
		return image
	}
	repo := image
	if i := strings.LastIndex(repo, ":"); i > strings.LastIndex(repo, "/") {
		repo = repo[:i]
	}
	for _, d := range repoDigests {
		if strings.HasPrefix(d, repo+"@") {
			return d
		}
	}
	return repoDigests[0]
}

var (
	llamaRelease = regexp.MustCompile(`(?:^|[^0-9a-z])b?(\d{3,})(?:[^0-9a-z]|$)`)
	tagRelease   = regexp.MustCompile(`(?:^|-)(b\d{3,})$`)
	versionLike  = regexp.MustCompile(`^v\d`)
)

// LlamaBuild is a llama.cpp release number from any of the ways it is
// written: "b11176", "b11176-f805c57" (build_info), "version: 11176
// (f805c57)" (--version). Text with no number comes back trimmed.
func LlamaBuild(text string) string {
	line := strings.TrimSpace(strings.SplitN(strings.TrimSpace(text), "\n", 2)[0])
	if m := llamaRelease.FindStringSubmatch(line); m != nil {
		return "b" + m[1]
	}
	return line
}

func plainVersion(text string) string {
	v := strings.TrimSpace(strings.SplitN(strings.TrimSpace(text), "\n", 2)[0])
	if versionLike.MatchString(v) {
		v = v[1:]
	}
	return v
}

func tagVersion(image string) string {
	image, _, _ = strings.Cut(image, "@")
	i := strings.LastIndex(image, ":")
	if i < 0 || i < strings.LastIndex(image, "/") {
		return ""
	}
	tag := image[i+1:]
	if m := tagRelease.FindStringSubmatch(tag); m != nil {
		return m[1]
	}
	if !strings.ContainsAny(tag, "0123456789") {
		return ""
	}
	return plainVersion(tag)
}
