// Package providers is the registry of inference engines the console can
// install: what each one is, which model formats it serves, the container
// image that drives it on each vendor's cards, and how its command line
// spells the fields the model form writes.
//
// A vendor record (internal/vendors) says how a card is reached -- the
// device flags, the selector variable, how a container declares it. A
// provider record says what runs on that card. The two are separate because
// the relation is many to many: one card can be served by llama.cpp and by
// vLLM, and each of those ships an image per vendor.
//
// The records are data, one directory per engine under engines/, each an
// engine.yaml and an icon, compiled in. Adding an engine is adding a
// directory; engines/README.md says what goes in it, and the tests here
// refuse a record that is incomplete or contradicts itself.
package providers

import (
	"bytes"
	"embed"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"slices"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/NoobBandi/TenkStack/internal/vendors"
)

// Build is one provider's container image for one vendor's cards, and what
// running it needs of the host.
type Build struct {
	Image string `yaml:"image"`
	// Label and Note name Image among its alternatives, for the person
	// choosing: 正式版, 每日版, the card family it is built for. Needed only
	// when there are alternatives.
	Label string `yaml:"label"`
	Note  string `yaml:"note"`
	// Alternatives are other images of the same build -- a nightly beside
	// the release, the build for another card family -- run with the same
	// flags and command. Image stays the one installed unless another is
	// picked, and the one an outdated launcher is brought up to.
	Alternatives []Choice `yaml:"alternatives"`
	// Requires names something the host must already have, so the UI can
	// say it before a multi-gigabyte download.
	Requires string `yaml:"requires"`
	// Verified is false for a recipe written from documentation and never
	// run on real hardware.
	Verified bool `yaml:"verified"`
	// Flags are the docker run arguments that hand the cards over. Empty
	// means the vendor's own passthrough for the whole machine.
	Flags []string `yaml:"flags"`
	// Command is what the launcher runs inside the image before the flags
	// llama-swap passes. Empty for an image whose entrypoint is the server.
	Command []string `yaml:"command"`
	// CacheDir is where the image keeps compiled kernels between runs, to
	// be mounted from the host so a restart does not compile again.
	CacheDir string `yaml:"cache_dir"`
	// MultiCard is what an entry spanning several of the vendor's cards
	// needs on top of Flags.
	MultiCard *MultiCard `yaml:"multi_card"`
	// Precisions are the stored precisions (as hfmodel names them: bf16,
	// fp8, int4, …) a model has been loaded in on this build. The catalog
	// marks any other 未驗證 rather than refusing it.
	Precisions []string `yaml:"precisions"`
}

// Choice is one image a build can run.
type Choice struct {
	Image string `yaml:"image"`
	Label string `yaml:"label"`
	Note  string `yaml:"note"`
}

// Choices are the build's images, its own first.
func (b Build) Choices() []Choice {
	return append([]Choice{{Image: b.Image, Label: b.Label, Note: b.Note}}, b.Alternatives...)
}

// Offers is whether image is one of the build's choices.
func (b Build) Offers(image string) bool {
	return slices.ContainsFunc(b.Choices(), func(c Choice) bool { return c.Image == image })
}

// MultiCard is applied by the launcher only when an entry's card selector
// names more than one card, and those runs keep their own kernel cache: a
// cache written by one arrangement can deadlock a run of the other.
type MultiCard struct {
	// Note is why, written into the launcher as a comment.
	Note string `yaml:"note"`
	// Setup is a script beside engine.yaml, .py or .sh, run inside the
	// image before the server. It is copied beside the launcher.
	Setup string `yaml:"setup"`
	// Entrypoint is the image's own start command as one shell line, which
	// running Setup first replaces; it belongs to the image tag above it.
	Entrypoint string `yaml:"entrypoint"`
	// Formerly are the start commands of the images this build used
	// before, so a launcher the console wrote then is still recognised as
	// its own and can be brought up to date.
	Formerly []string `yaml:"formerly"`
	// Flags are docker run arguments added for such an entry.
	Flags []string `yaml:"flags"`

	script []byte
}

// Script is the setup script's bytes.
func (m *MultiCard) Script() []byte { return m.script }

// Runner is the interpreter for the setup script.
func (m *MultiCard) Runner() string {
	if path.Ext(m.Setup) == ".sh" {
		return "bash"
	}
	return "python3"
}

// Quant is one quantisation a provider can apply to plain weights as it
// loads them. Shrink is the weights' footprint against bf16.
type Quant struct {
	Value string `yaml:"value"`
	// Older is the same method under the name images before a rename take,
	// offered in Value's place by an image that does not have Value.
	Older string `yaml:"older"`
	Label string `yaml:"label"`
	// Note is what it costs and saves, for the help under the field.
	Note   string  `yaml:"note"`
	Shrink float64 `yaml:"shrink"`
}

// Recommendation is flags a model family needs on this engine, offered
// when its weights are picked. Match is a regular expression against the
// architecture a model's config.json declares.
type Recommendation struct {
	Match string   `yaml:"match"`
	Flags []string `yaml:"flags"`
	Note  string   `yaml:"note"`
	// Vendors limits the rule to these vendors' builds: a flag that works
	// around one vendor's image is not offered on another's. Empty is all.
	Vendors []string `yaml:"vendors"`
}

// SamplingControls are the chat panel's sampling controls, by the names
// llama-server takes. An engine's `sampling` maps each to its own name.
var SamplingControls = []string{"temperature", "top_p", "top_k", "min_p", "repeat_penalty",
	"presence_penalty", "frequency_penalty", "seed", "reasoning_budget_tokens"}

// Speculation is the flag that turns speculative decoding on for an entry,
// and the request fields the engine then refuses outright.
type Speculation struct {
	Flag    string   `yaml:"flag"`
	Refuses []string `yaml:"refuses"`
}

// The forms a provider's entries are edited with.
const (
	// FormLlama is llama.cpp's: GGUF files, layers, a projector, sampling,
	// and /props and /slots read from the running server.
	FormLlama = "llama"
	// FormServer is an OpenAI-compatible server of a directory of weights:
	// a context length, a card count, a memory share, a quantisation.
	FormServer = "server"
)

// The fields of the server form, as ServerFlags keys.
const (
	FlagModel          = "model"
	FlagServedName     = "served_name"
	FlagContext        = "context"
	FlagTensorParallel = "tensor_parallel"
	FlagMemory         = "memory"
	FlagQuantization   = "quantization"
)

// Provider is one inference engine.
type Provider struct {
	Key  string `yaml:"key"`
	Name string `yaml:"name"`
	// Order places it in the store; the default engine comes first anyway.
	Order int `yaml:"order"`
	// Default is the engine a model uses unless it says otherwise. There is
	// exactly one, and it cannot be removed.
	Default bool `yaml:"default"`
	// Program is the process the launcher starts, for the script's header.
	Program string `yaml:"program"`
	// Summary is the one line a newcomer reads to choose.
	Summary  string `yaml:"summary"`
	Category string `yaml:"category"`
	// Formats are the model file formats it serves: gguf, safetensors.
	Formats []string `yaml:"formats"`
	Site    string   `yaml:"site"`
	// Icon is a file beside engine.yaml; IconSource is where it came from.
	Icon       string `yaml:"icon"`
	IconSource string `yaml:"icon_source"`
	// Form is how its entries are edited and built: FormLlama or FormServer.
	Form string `yaml:"form"`
	// ServerFlags is how a FormServer engine spells each field of the form.
	ServerFlags map[string]string `yaml:"flags"`
	// DropMaxTokens: the engine refuses a request whose max_tokens reaches
	// the context length, so the proxy leaves it out.
	DropMaxTokens bool `yaml:"drop_max_tokens"`
	// Tools: entries declare tool calling, which a FormServer engine cannot
	// be asked about the way llama-server's /props can.
	Tools bool `yaml:"tools"`
	// UsagePerChunk: asked for stream_options.continuous_usage_stats, the
	// engine puts the running token counts on every streamed chunk. The
	// proxy asks for them to measure a reply -- a chunk can carry several
	// tokens when the engine speculates -- and takes them out again before
	// the client sees the stream.
	UsagePerChunk bool `yaml:"usage_per_chunk"`
	// Sampling is how the engine names each of SamplingControls. A control
	// left out does not exist there: the chat panel hides it and does not
	// send it. Empty means every control under its own name.
	Sampling map[string]string `yaml:"sampling"`
	// Speculation, when set, is what an entry that speculates cannot take.
	Speculation *Speculation `yaml:"speculation"`
	// Builds by vendor key. A vendor with no build has no way to run this
	// provider on its cards, and the store does not offer it there.
	Builds map[string]Build `yaml:"builds"`
	// Fallback is a build that runs on any vendor's card, offered as a
	// variant rather than a default: it is slower and needs something of
	// the host the vendor build does not.
	Fallback      *Build `yaml:"-"`
	FallbackLabel string `yaml:"-"`
	// EnvPrefix names the launcher's own variables: <PREFIX>_IMAGE overrides
	// the image, <PREFIX>_NAME the container name.
	EnvPrefix string `yaml:"env_prefix"`
	// Online are the quantisations worth offering for a model published in
	// bf16. The image is asked which of them it actually has.
	Online      []Quant          `yaml:"online_quantization"`
	Recommended []Recommendation `yaml:"recommended"`

	// ModelFlag names the weights on the command line.
	ModelFlag string `yaml:"-"`
	// Managed are the flags the console's own form writes, so an entry read
	// back can tell its fields from what somebody typed by hand.
	Managed []string `yaml:"-"`

	// The macro and script names llama.cpp had before the registry, kept
	// so a config written then still resolves. Empty means the key.
	MacroPrefix  string `yaml:"macro_prefix"`
	ScriptPrefix string `yaml:"script_prefix"`

	iconData []byte
}

// record is engine.yaml as written.
type record struct {
	Provider `yaml:",inline"`
	// The fallback build's label is its Build.Label, which names its image
	// the way a build's own label does.
	Fallback *Build `yaml:"fallback"`
}

// Macro is the llama-swap macro naming this provider's launcher for one
// vendor: llama-intel, vllm-intel.
func (p Provider) Macro(vendor string) string {
	prefix := p.MacroPrefix
	if prefix == "" {
		prefix = p.Key + "-"
	}
	return prefix + vendor
}

// ScriptName is the launcher script's file name for one vendor.
func (p Provider) ScriptName(vendor string) string {
	prefix := p.ScriptPrefix
	if prefix == "" {
		prefix = p.Key + "-"
	}
	return prefix + vendor + ".sh"
}

// Serves says whether the provider runs models in this format.
func (p Provider) Serves(format string) bool {
	for _, f := range p.Formats {
		if f == format {
			return true
		}
	}
	return false
}

// IconData is the icon file's bytes, and its media type.
func (p Provider) IconData() ([]byte, string) {
	switch strings.ToLower(path.Ext(p.Icon)) {
	case ".svg":
		return p.iconData, "image/svg+xml"
	case ".webp":
		return p.iconData, "image/webp"
	}
	return p.iconData, "image/png"
}

// Keys the code names directly.
const (
	LlamaCpp = "llamacpp"
	VLLM     = "vllm"
)

//go:embed engines
var engines embed.FS

var registry = func() []Provider {
	all, err := load(engines)
	if err != nil {
		// The records are compiled in and tested; a broken one is a build
		// that should not have shipped.
		panic(err)
	}
	return all
}()

var keyPattern = regexp.MustCompile(`^[a-z][a-z0-9]*$`)

// load reads every engines/<key>/engine.yaml and checks it.
func load(files fs.FS) ([]Provider, error) {
	dirs, err := fs.ReadDir(files, "engines")
	if err != nil {
		return nil, err
	}
	var out []Provider
	defaults := 0
	macros := map[string]string{}
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		p, err := loadOne(files, d.Name())
		if err != nil {
			return nil, fmt.Errorf("engines/%s: %w", d.Name(), err)
		}
		if p.Default {
			defaults++
		}
		for _, v := range vendors.All() {
			m := p.Macro(v.Key)
			if other, taken := macros[m]; taken {
				return nil, fmt.Errorf("engines/%s: macro %s is also %s's", d.Name(), m, other)
			}
			macros[m] = p.Key
		}
		out = append(out, p)
	}
	if defaults != 1 {
		return nil, fmt.Errorf("engines: %d records say default: true, want exactly one", defaults)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Default != out[j].Default {
			return out[i].Default
		}
		if out[i].Order != out[j].Order {
			return out[i].Order < out[j].Order
		}
		return out[i].Key < out[j].Key
	})
	return out, nil
}

func loadOne(files fs.FS, dir string) (Provider, error) {
	raw, err := fs.ReadFile(files, path.Join("engines", dir, "engine.yaml"))
	if err != nil {
		return Provider{}, err
	}
	var r record
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(&r); err != nil {
		return Provider{}, fmt.Errorf("engine.yaml: %w", err)
	}
	p := r.Provider
	if r.Fallback != nil {
		p.Fallback, p.FallbackLabel = r.Fallback, r.Fallback.Label
	}
	switch {
	case p.Key != dir:
		return p, fmt.Errorf("key %q is not the directory's name", p.Key)
	case !keyPattern.MatchString(p.Key):
		return p, fmt.Errorf("key %q: lower case letters and digits only", p.Key)
	case p.Name == "" || p.Summary == "" || p.Program == "" || p.Site == "":
		return p, fmt.Errorf("name, summary, program and site are required")
	case p.EnvPrefix == "":
		return p, fmt.Errorf("env_prefix is required")
	case len(p.Formats) == 0:
		return p, fmt.Errorf("formats is empty")
	case len(p.Builds) == 0 && p.Fallback == nil:
		return p, fmt.Errorf("no builds: it could run nowhere")
	}
	if p.Category == "" {
		p.Category = "llm"
	}
	for _, f := range p.Formats {
		if f != "gguf" && f != "safetensors" {
			return p, fmt.Errorf("format %q: gguf or safetensors", f)
		}
	}
	for vendor, b := range p.Builds {
		if vendors.Get(vendor) == nil {
			return p, fmt.Errorf("build for %q: no such vendor", vendor)
		}
		if b.Image == "" {
			return p, fmt.Errorf("build for %s has no image", vendor)
		}
		if len(b.Alternatives) > 0 {
			if b.Label == "" {
				return p, fmt.Errorf("build for %s has alternatives, so its own image needs a label", vendor)
			}
			seen := map[string]bool{}
			for _, c := range b.Choices() {
				if c.Image == "" || c.Label == "" {
					return p, fmt.Errorf("build for %s: every alternative needs an image and a label", vendor)
				}
				if seen[c.Image] {
					return p, fmt.Errorf("build for %s offers %s twice", vendor, c.Image)
				}
				seen[c.Image] = true
			}
		}
		if m := b.MultiCard; m != nil {
			if vendors.Get(vendor).SelectorVar == "" {
				return p, fmt.Errorf("multi_card for %s: the vendor has no card selector to tell one card from several", vendor)
			}
			if m.Setup == "" {
				continue
			}
			if ext := path.Ext(m.Setup); ext != ".py" && ext != ".sh" {
				return p, fmt.Errorf("multi_card.setup %q: .py or .sh", m.Setup)
			}
			if m.Entrypoint == "" || len(b.Command) > 0 {
				return p, fmt.Errorf("multi_card.setup for %s needs the image's entrypoint restated, and no command", vendor)
			}
			script, err := fs.ReadFile(files, path.Join("engines", dir, m.Setup))
			if err != nil {
				return p, fmt.Errorf("multi_card.setup: %w", err)
			}
			m.script = script
		}
	}
	if p.Fallback != nil && (p.Fallback.Image == "" || p.FallbackLabel == "") {
		return p, fmt.Errorf("fallback needs an image and a label")
	}
	for control, name := range p.Sampling {
		if !slices.Contains(SamplingControls, control) {
			return p, fmt.Errorf("sampling.%s: not a chat control (%s)", control, strings.Join(SamplingControls, ", "))
		}
		if name == "" {
			return p, fmt.Errorf("sampling.%s has no name; leave the control out instead", control)
		}
	}
	if sp := p.Speculation; sp != nil && (!strings.HasPrefix(sp.Flag, "--") || len(sp.Refuses) == 0) {
		return p, fmt.Errorf("speculation needs a flag starting with -- and the fields it refuses")
	}
	for _, rec := range p.Recommended {
		if _, err := regexp.Compile(rec.Match); err != nil {
			return p, fmt.Errorf("recommended match %q: %w", rec.Match, err)
		}
		if len(rec.Flags) == 0 {
			return p, fmt.Errorf("recommended match %q has no flags", rec.Match)
		}
		for _, v := range rec.Vendors {
			if _, ok := p.Builds[v]; !ok {
				return p, fmt.Errorf("recommended match %q names vendor %q, which has no build", rec.Match, v)
			}
		}
	}
	switch p.Form {
	case FormLlama:
		p.ModelFlag = "--model"
	case FormServer:
		for _, field := range []string{FlagModel, FlagServedName, FlagContext} {
			if !strings.HasPrefix(p.ServerFlags[field], "--") {
				return p, fmt.Errorf("flags.%s is required and starts with --", field)
			}
		}
		for field, flag := range p.ServerFlags {
			switch field {
			case FlagModel, FlagServedName, FlagContext, FlagTensorParallel, FlagMemory, FlagQuantization:
			default:
				return p, fmt.Errorf("flags.%s: not a field of the server form", field)
			}
			if !strings.HasPrefix(flag, "--") {
				return p, fmt.Errorf("flags.%s: %q does not start with --", field, flag)
			}
		}
		p.ModelFlag = p.ServerFlags[FlagModel]
		p.Managed = []string{"--host", "--port"}
		for _, field := range []string{FlagModel, FlagServedName, FlagContext, FlagTensorParallel, FlagMemory, FlagQuantization} {
			if flag := p.ServerFlags[field]; flag != "" {
				p.Managed = append(p.Managed, flag)
			}
		}
	default:
		return p, fmt.Errorf("form %q: llama or server", p.Form)
	}
	if len(p.Online) > 0 && p.ServerFlags[FlagQuantization] == "" && p.Form == FormServer {
		return p, fmt.Errorf("online_quantization without flags.quantization")
	}
	if p.Icon == "" {
		return p, fmt.Errorf("icon is required")
	}
	switch strings.ToLower(path.Ext(p.Icon)) {
	case ".svg", ".png", ".webp":
	default:
		return p, fmt.Errorf("icon %q: svg, png or webp", p.Icon)
	}
	icon, err := fs.ReadFile(files, path.Join("engines", dir, p.Icon))
	if err != nil {
		return p, fmt.Errorf("icon: %w", err)
	}
	if len(icon) > 64<<10 {
		return p, fmt.Errorf("icon is %d KB; keep it under 64", len(icon)>>10)
	}
	p.iconData = icon
	return p, nil
}

// All is every provider, in the order the store shows them.
func All() []Provider { return append([]Provider(nil), registry...) }

func Get(key string) *Provider {
	for _, p := range registry {
		if p.Key == key {
			p := p
			return &p
		}
	}
	return nil
}

// DefaultProvider is the engine a model uses unless it says otherwise.
func DefaultProvider() Provider {
	for _, p := range registry {
		if p.Default {
			return p
		}
	}
	return registry[0]
}

// Resolve is the provider and vendor a launcher macro names, for a macro
// this console wrote: llama-nvidia, vllm-intel. A macro that matches no
// record -- a native build somebody registered by hand -- is nobody's.
func Resolve(macro string) (Provider, string, bool) {
	for _, p := range registry {
		for _, v := range vendors.All() {
			if p.Macro(v.Key) == macro {
				return p, v.Key, true
			}
		}
	}
	return Provider{}, "", false
}

// Unknown is the error for a key no record has.
type Unknown struct{ Key string }

func (e *Unknown) Error() string { return fmt.Sprintf("沒有叫 %s 的執行環境", e.Key) }

// Lookup is Get with an error for the handler to return.
func Lookup(key string) (Provider, error) {
	if p := Get(key); p != nil {
		return *p, nil
	}
	return Provider{}, &Unknown{key}
}

// ChatParams is the chat panel's controls an entry of this engine takes,
// each under the engine's own name. cmd is the entry's command line, which
// says whether it speculates.
func (p Provider) ChatParams(cmd string) map[string]string {
	refused := p.Refused(cmd)
	out := map[string]string{}
	for _, control := range SamplingControls {
		name := control
		if len(p.Sampling) > 0 {
			n, ok := p.Sampling[control]
			if !ok {
				continue
			}
			name = n
		}
		if !slices.Contains(refused, name) {
			out[control] = name
		}
	}
	return out
}

// Refused is the request fields an entry with this command line cannot
// take: what the engine refuses while it speculates, if the entry does.
func (p Provider) Refused(cmd string) []string {
	if p.Speculation == nil {
		return nil
	}
	if !regexp.MustCompile(`(^|\s)` + regexp.QuoteMeta(p.Speculation.Flag) + `(\s|=|$)`).MatchString(cmd) {
		return nil
	}
	return p.Speculation.Refuses
}
