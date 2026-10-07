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

	"github.com/NoobBandi/TenkStack/internal/api"
)

// Long enough for a cold binary, short enough that a program which does
// not answer --help does not hold a request open.
const helpTimeout = 20 * time.Second

var (
	groupLine = regexp.MustCompile(`^-{3,}\s*(.+?)\s*-{3,}$`)
	flagName  = regexp.MustCompile(`^-{1,2}[A-Za-z0-9][\w.-]*$`)
	gap       = regexp.MustCompile(`\S(\s{2,})\S`)
	envNote   = regexp.MustCompile(`\s*\(env: ([A-Z_0-9]+)\)`)
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

// split cuts an entry's first line at the description column. Two spaces
// before the column, not one: argparse puts a long head on a line of its
// own, and "  --quantization-config QUANTIZATION_CONFIG" has a single space
// at column 24 that cut its placeholder off as if it were the description.
func split(line string, column int) (string, string) {
	if column >= 2 && len(line) > column && line[column-1] == ' ' && line[column-2] == ' ' {
		return line[:column], strings.TrimSpace(line[column:])
	}
	return line, ""
}

// Spec is one flag with what its help says beyond what the flag picker
// shows: the environment variable llama.cpp also reads it from, which the
// launch-command reader needs because a model entry's env can set a flag
// as well as its cmd.
type Spec struct {
	api.Flag
	Env string
}

// head reads the names and the placeholder off the start of one entry.
//
// Every token that starts with a dash is a spelling, and anything else is
// the value's placeholder. Matching names anywhere in the head instead read
// a choice list as aliases -- "--spec-type none,draft-simple,draft-mtp"
// gave --spec-type the aliases -simple and -mtp -- and recognising a
// placeholder only by its shape missed the ones that are not a capitalised
// word: {none,layer,row,tensor}, N0,N1,N2,... and a bare choice list. A
// spelling after a placeholder still counts when the placeholder ends in a
// comma, because argparse repeats it per spelling ("--quantization
// QUANTIZATION, -q QUANTIZATION"); otherwise the head has run into prose,
// as in vLLM's "--tool-call-parser {...} or name registered in
// --tool-parser-plugin".
func head(text string) (names []string, takesValue bool) {
	more := true
	for _, field := range strings.Fields(text) {
		name := strings.TrimSuffix(field, ",")
		switch {
		case flagName.MatchString(name) && more:
			names = append(names, name)
		case len(names) > 0:
			takesValue = true
			more = strings.HasSuffix(field, ",")
		}
	}
	return names, takesValue
}

// Parse turns --help output into flags, joining wrapped descriptions.
func Parse(text string) []api.Flag { return flagsOf(ParseSpecs(text)) }

// ParseSpecs is Parse keeping each flag's environment variable.
func ParseSpecs(text string) []Spec {
	var out []Spec
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
			lead, tail := split(line, column)
			names, takesValue := head(lead)
			if len(names) == 0 {
				current = -1
				continue
			}
			out = append(out, Spec{Flag: api.Flag{
				Names: names, Group: group, Help: strings.TrimSpace(tail), TakesValue: takesValue,
			}})
			current = len(out) - 1
		} else if current >= 0 {
			out[current].Help = strings.TrimSpace(out[current].Help + " " + trimmed)
		}
	}
	// The note is kept as Env and taken out of the help, where the picker
	// would show it as part of the description.
	for i := range out {
		if m := envNote.FindStringSubmatch(out[i].Help); m != nil {
			out[i].Env = m[1]
		}
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
	items map[key][]Spec
	// Quantisation methods per image id, from the image itself, with the
	// ids being asked now and when an attempt last failed.
	quant  map[string][]string
	asking map[string]bool
	failed map[string]time.Time
}

func NewCache() *Cache {
	return &Cache{
		items: map[key][]Spec{}, quant: map[string][]string{},
		asking: map[string]bool{}, failed: map[string]time.Time{},
	}
}

// vLLM's own list of what --quantization accepts. Asked of the image rather
// than written here, because the list moves with every release and the
// Intel build adds methods the upstream one has not got. Nothing in it says
// which methods apply to plain weights on the way in and which only name a
// checkpoint format, so the caller still decides what to offer.
const quantListing = "from vllm.model_executor.layers.quantization import QUANTIZATION_METHODS\n" +
	"print('\\n'.join(QUANTIZATION_METHODS))"

// Quantizations is the methods one vLLM image accepts, cached by image id
// so a rolling tag re-asked after an update gets a fresh answer. Empty when
// the image has not said yet, which the caller treats as "offer the
// record's".
//
// The image is asked in the background, never within the request that
// wanted the answer: starting vLLM's Python takes longer than a page waits,
// so asked inline the command was killed with the request every time, the
// answer was never cached, and every visit to the engines page stalled for
// the length of the attempt. A failed attempt is not repeated for a while.
func (c *Cache) Quantizations(_ context.Context, image, imageID string) []string {
	if imageID == "" {
		imageID = image
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if cached, ok := c.quant[imageID]; ok {
		return cached
	}
	if c.asking[imageID] || time.Since(c.failed[imageID]) < quantRetry {
		return nil
	}
	c.asking[imageID] = true
	go c.askQuantizations(image, imageID)
	return nil
}

// quantRetry is how long a failed attempt to ask an image stands.
const quantRetry = 10 * time.Minute

func (c *Cache) askQuantizations(image, imageID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "run", "--rm", "--entrypoint", "python3", image, "-c", quantListing).Output()
	var methods []string
	for _, line := range strings.Split(string(out), "\n") {
		if t := strings.TrimSpace(line); t != "" && !strings.ContainsAny(t, " :[") {
			methods = append(methods, t)
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.asking, imageID)
	if err != nil || len(methods) == 0 {
		log.Printf("could not ask %s for its quantization methods: %v", image, err)
		c.failed[imageID] = time.Now()
		return
	}
	c.quant[imageID] = methods
}

// LlamaServer asks a launcher for its flags. Run through the wrapper
// llama-swap uses, because a SYCL build needs oneAPI's runtime on its
// library path and asking the binary directly gets a linker error.
func (c *Cache) LlamaServer(ctx context.Context, launchers []string, fallback string) []api.Flag {
	return flagsOf(c.LlamaServerSpecs(ctx, launchers, fallback))
}

// LlamaServerSpecs is LlamaServer with each flag's environment variable,
// for reading a model entry's launch command.
func (c *Cache) LlamaServerSpecs(ctx context.Context, launchers []string, fallback string) []Spec {
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
		return []Spec{}
	}
	st, err := os.Stat(binary)
	if err != nil {
		return []Spec{}
	}
	k := key{binary, st.ModTime().UnixNano()}
	c.mu.Lock()
	cached, ok := c.items[k]
	c.mu.Unlock()
	if ok {
		return cached
	}
	specs := ParseSpecs(run(ctx, binary, "--help"))
	if len(specs) > 0 {
		c.mu.Lock()
		c.items[k] = specs
		c.mu.Unlock()
	}
	return specs
}

func flagsOf(specs []Spec) []api.Flag {
	out := make([]api.Flag, len(specs))
	for i, s := range specs {
		out[i] = s.Flag
	}
	return out
}

// Comfy asks the ComfyUI inside one container, keyed on its image id so a
// new image asks again and a restart does not.
func (c *Cache) Comfy(ctx context.Context, container, imageID string) []api.Flag {
	k := key{"comfyui:" + imageID, 0}
	c.mu.Lock()
	cached, ok := c.items[k]
	c.mu.Unlock()
	if ok {
		return flagsOf(cached)
	}
	specs := ParseSpecs(run(ctx, "docker", "exec", container, "sh", "-lc", "cd /root/ComfyUI && python main.py --help"))
	if len(specs) > 0 {
		c.mu.Lock()
		c.items[k] = specs
		c.mu.Unlock()
	}
	return flagsOf(specs)
}
