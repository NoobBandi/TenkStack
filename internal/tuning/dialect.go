package tuning

import "strings"

// A dialect is how one engine spells its flags and what each one means.
type dialect struct {
	aliases map[string]spelling
	env     map[string]spelling
	// Canonical names that take no value. A flag missing here takes one.
	bools   map[string]bool
	rules   map[string]rule
	ignored map[string]bool
	// Both llama.cpp and argparse read "--top_p" as "--top-p".
	underscores bool
	// vLLM sets one key of a JSON flag as "--speculative-config.method mtp".
	dottedKeys bool
	// The JSON flags, read once every key has been seen.
	readers map[string]reader
}

type spelling struct {
	canonical string
	negated   bool // --no-kv-unified
}

// A rule places a flag's value. has says whether a value was given at all
// (a bare -fa); key is the JSON key of a dotted spelling. It reports
// whether the value could be placed.
type rule func(b *builder, key, value string, has, negated bool) bool

// A reader interprets a JSON flag's merged keys, naming those it cannot
// place with b.unknown.
type reader func(b *builder, flag string, m map[string]any)

// entry is one row of a built-in table: the canonical spelling first.
// Without a rule a flag is either ignored -- the local, engine and
// platform settings the devlog keeps out of a recipe -- or known but not
// placed, which is reported like any other unrecognized flag.
type entry struct {
	names  []string
	env    string
	bool   bool
	rule   rule
	ignore bool
}

func newDialect(entries []entry) *dialect {
	d := &dialect{
		aliases: map[string]spelling{}, env: map[string]spelling{},
		bools: map[string]bool{}, rules: map[string]rule{}, ignored: map[string]bool{},
		readers: map[string]reader{},
	}
	for _, e := range entries {
		c := e.names[0]
		d.add(c, e.names, e.env)
		d.bools[c] = e.bool
		if e.rule != nil {
			d.rules[c] = e.rule
		}
		if e.ignore {
			d.ignored[c] = true
		}
	}
	return d
}

// negation is whether a spelling turns its flag off. Only within a group
// that also has a positive spelling: --no-host on its own is a switch that
// is on when given.
func negation(name string) bool {
	return strings.HasPrefix(name, "--no-") || strings.HasPrefix(name, "-no-")
}

// add maps every spelling of one flag to its canonical name. A spelling
// already taken keeps its first meaning, so the built-in table wins over a
// help text that groups spellings differently.
func (d *dialect) add(canonical string, names []string, env string) {
	positive := false
	for _, n := range names {
		positive = positive || !negation(n)
	}
	for _, n := range names {
		if _, taken := d.aliases[n]; !taken {
			d.aliases[n] = spelling{canonical, positive && negation(n)}
		}
	}
	if _, taken := d.env[env]; env != "" && !taken {
		d.env[env] = spelling{canonical, false}
	}
}

// learn adds one flag from an engine's help. A flag the built-in table
// knows by any spelling joins it; a new one is named by its first long
// spelling and has no rule, so it is reported rather than guessed at.
func (d *dialect) learn(f Flag) {
	if len(f.Names) == 0 {
		return
	}
	canonical := ""
	for _, n := range f.Names {
		if s, ok := d.aliases[n]; ok {
			canonical = s.canonical
			break
		}
	}
	if canonical == "" {
		canonical = f.Names[0]
		for _, n := range f.Names {
			if strings.HasPrefix(n, "--") && !negation(n) {
				canonical = n
				break
			}
		}
	}
	d.add(canonical, f.Names, f.Env)
	// The build in hand decides whether a value follows: -fa was a switch
	// before it took on|off|auto.
	d.bools[canonical] = !f.TakesValue
}

// normalise splits off a dotted JSON key and folds underscores.
func (d *dialect) normalise(name string) (string, string) {
	if !strings.HasPrefix(name, "--") {
		return name, ""
	}
	key := ""
	if d.dottedKeys {
		name, key, _ = strings.Cut(name, ".")
	}
	if d.underscores {
		name = strings.ReplaceAll(name, "_", "-")
	}
	return name, key
}

func (d *dialect) resolve(name string) (spelling, bool) {
	if s, ok := d.aliases[name]; ok {
		return s, true
	}
	// argparse's BooleanOptionalAction and llama.cpp both add a --no- form
	// to a switch; one the table did not list still means the same.
	if rest, ok := strings.CutPrefix(name, "--no-"); ok {
		if s, ok := d.aliases["--"+rest]; ok && d.bools[s.canonical] {
			return spelling{s.canonical, !s.negated}, true
		}
	}
	return spelling{}, false
}

func (d *dialect) apply(b *builder, s spelling, key, value string, has bool) {
	c := s.canonical
	if d.ignored[c] {
		return
	}
	r := d.rules[c]
	if r == nil || (key != "" && d.readers[c] == nil) {
		b.unknown(c + dotted(key))
		return
	}
	if !r(b, key, value, has, s.negated) {
		b.unknown(c + dotted(key))
	}
}

// generic is what any engine's command is read with when the engine is not
// one of the known ones: nothing is placed, and only what is plainly local
// is left out of the report.
var generic = []entry{
	{names: []string{"--host"}, ignore: true},
	{names: []string{"--port"}, ignore: true},
	{names: []string{"--model"}, ignore: true},
	{names: []string{"--served-model-name"}, ignore: true},
	{names: []string{"--api-key"}, ignore: true},
}

func dialectFor(engine string, help []Flag) *dialect {
	var d *dialect
	switch engine {
	case LlamaCpp:
		d = newDialect(llamaCppTable)
		d.underscores = true
		d.readers["--chat-template-kwargs"] = readTemplateKwargs
		for _, f := range help {
			d.learn(f)
		}
	case VLLM:
		d = newDialect(vllmTable)
		d.underscores = true
		d.dottedKeys = true
		d.readers["--speculative-config"] = readVLLMSpeculative
		d.readers["--default-chat-template-kwargs"] = readTemplateKwargs
		d.readers["--override-generation-config"] = readGenerationConfig
	case SGLang:
		d = newDialect(sglangTable)
		d.underscores = true
	default:
		d = newDialect(generic)
	}
	return d
}
