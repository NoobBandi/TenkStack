// Package flags reads the launch flags a binary actually has from its own
// --help, so the interface never offers a switch this build lacks.
package flags

import (
	"context"
	"log"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
)

// Long enough for a cold binary, short enough that a program which does
// not answer --help does not hold a request open.
const helpTimeout = 20 * time.Second

var (
	groupLine = regexp.MustCompile(`^-{3,}\s*(.+?)\s*-{3,}$`)
	flagName  = regexp.MustCompile(`-{1,2}[A-Za-z0-9][\w.-]*`)
	// A flag takes a value when its head ends in a placeholder: N, FNAME,
	// <0|1>, MODE.
	takesValue = regexp.MustCompile(`(?:[A-Z][\w-]*|<[^>]+>|\[[^\]]+\])\s*$`)
	gap        = regexp.MustCompile(`\S(\s{2,})\S`)
	envNote    = regexp.MustCompile(`\s*\(env: [A-Z_0-9]+\)`)
	// A flag whose whole job is to print something and stop.
	action = regexp.MustCompile(`(?i)^(show|print|list|display)\b`)
)

// helpColumn is where this program starts its descriptions, measured
// rather than assumed: llama.cpp pads names to column 40, argparse to 24.
func helpColumn(lines []string) int {
	votes := map[int]int{}
	for _, line := range lines {
		if !(strings.HasPrefix(line, " ") || strings.HasPrefix(line, "-")) || !strings.HasPrefix(strings.TrimSpace(line), "-") {
			continue
		}
		if m := gap.FindStringSubmatchIndex(line); m != nil {
			votes[m[1]-1]++
		}
	}
	if len(votes) == 0 {
		return 40
	}
	best, bestN := 0, -1
	for col, n := range votes {
		if n > bestN || (n == bestN && col < best) {
			best, bestN = col, n
		}
	}
	return best
}

func split(line string, column int) (string, string) {
	if len(line) > column && line[column-1] == ' ' {
		return line[:column], strings.TrimSpace(line[column:])
	}
	return line, ""
}

// Parse turns --help output into flags, joining wrapped descriptions.
func Parse(text string) []api.Flag {
	var out []api.Flag
	group := ""
	current := -1
	lines := strings.Split(text, "\n")
	column := helpColumn(lines)
	for _, raw := range lines {
		line := strings.TrimRight(raw, " \t\r\n")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if m := groupLine.FindStringSubmatch(trimmed); m != nil {
			group = m[1]
			current = -1
			continue
		}
		startsFlag := strings.HasPrefix(line, "-") ||
			(strings.HasPrefix(line, "  ") && !strings.HasPrefix(line, "    ") && strings.HasPrefix(trimmed, "-"))
		if startsFlag {
			head, tail := split(line, column)
			names := flagName.FindAllString(head, -1)
			if len(names) == 0 {
				current = -1
				continue
			}
			out = append(out, api.Flag{
				Names: names, Group: group, Help: strings.TrimSpace(tail),
				TakesValue: takesValue.MatchString(strings.TrimRight(head, " \t")),
			})
			current = len(out) - 1
		} else if current >= 0 {
			out[current].Help = strings.TrimSpace(out[current].Help + " " + trimmed)
		}
	}
	for i := range out {
		out[i].Help = strings.TrimSpace(envNote.ReplaceAllString(out[i].Help, ""))
	}
	return out
}

func IsAction(f api.Flag) bool { return action.MatchString(f.Help) }

// Configurable drops the flags that merely report.
func Configurable(flags []api.Flag) []api.Flag {
	out := []api.Flag{}
	for _, f := range flags {
		if !IsAction(f) {
			out = append(out, f)
		}
	}
	return out
}

func run(ctx context.Context, argv ...string) string {
	ctx, cancel := context.WithTimeout(ctx, helpTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, argv[0], argv[1:]...).CombinedOutput()
	if err != nil && len(out) == 0 {
		log.Printf("could not ask %s for its flags: %v", argv[0], err)
		return ""
	}
	return string(out)
}

type key struct {
	path  string
	stamp int64
}

// Cache holds parsed help per binary, keyed on the path and its mtime: a
// rebuilt llama-server is a different set of flags under the same name.
type Cache struct {
	mu    sync.Mutex
	items map[key][]api.Flag
	// Quantisation methods per image id, from the image itself.
	quant map[string][]string
}

func NewCache() *Cache { return &Cache{items: map[key][]api.Flag{}, quant: map[string][]string{}} }

// vLLM's own list of what --quantization accepts. Asked of the image rather
// than written here, because the list moves with every release and the
// Intel build adds methods the upstream one has not got. Nothing in it says
// which methods apply to plain weights on the way in and which only name a
// checkpoint format, so the caller still decides what to offer.
const quantListing = "from vllm.model_executor.layers.quantization import QUANTIZATION_METHODS\n" +
	"print('\\n'.join(QUANTIZATION_METHODS))"

// Quantizations is the methods one vLLM image accepts, cached by image id
// so a rolling tag re-asked after an update gets a fresh answer. Empty when
// the image cannot say, which the caller treats as "offer the record's".
func (c *Cache) Quantizations(ctx context.Context, image, imageID string) []string {
	if imageID == "" {
		imageID = image
	}
	c.mu.Lock()
	cached, ok := c.quant[imageID]
	c.mu.Unlock()
	if ok {
		return cached
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "run", "--rm", "--entrypoint", "python3", image, "-c", quantListing).Output()
	if err != nil {
		log.Printf("could not ask %s for its quantization methods: %v", image, err)
		return nil
	}
	var methods []string
	for _, line := range strings.Split(string(out), "\n") {
		if t := strings.TrimSpace(line); t != "" && !strings.ContainsAny(t, " :[") {
			methods = append(methods, t)
		}
	}
	if len(methods) > 0 {
		c.mu.Lock()
		c.quant[imageID] = methods
		c.mu.Unlock()
	}
	return methods
}

// LlamaServer asks a launcher for its flags. Run through the wrapper
// llama-swap uses, because a SYCL build needs oneAPI's runtime on its
// library path and asking the binary directly gets a linker error.
func (c *Cache) LlamaServer(ctx context.Context, launchers []string, fallback string) []api.Flag {
	binary := ""
	for _, l := range launchers {
		if st, err := os.Stat(l); err == nil && st.Mode().IsRegular() {
			binary = l
			break
		}
	}
	if binary == "" {
		if st, err := os.Stat(fallback); err == nil && st.Mode().IsRegular() {
			binary = fallback
		}
	}
	if binary == "" {
		return []api.Flag{}
	}
	st, err := os.Stat(binary)
	if err != nil {
		return []api.Flag{}
	}
	k := key{binary, st.ModTime().UnixNano()}
	c.mu.Lock()
	cached, ok := c.items[k]
	c.mu.Unlock()
	if ok {
		return cached
	}
	flags := Parse(run(ctx, binary, "--help"))
	if len(flags) > 0 {
		c.mu.Lock()
		c.items[k] = flags
		c.mu.Unlock()
	}
	return flags
}

// Comfy asks the ComfyUI inside one container, keyed on its image id so a
// new image asks again and a restart does not.
func (c *Cache) Comfy(ctx context.Context, container, imageID string) []api.Flag {
	k := key{"comfyui:" + imageID, 0}
	c.mu.Lock()
	cached, ok := c.items[k]
	c.mu.Unlock()
	if ok {
		return cached
	}
	flags := Parse(run(ctx, "docker", "exec", container, "sh", "-lc", "cd /root/ComfyUI && python main.py --help"))
	if len(flags) > 0 {
		c.mu.Lock()
		c.items[k] = flags
		c.mu.Unlock()
	}
	return flags
}
