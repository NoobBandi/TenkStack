// Package tuning reads a llama-swap launch command into a benchmark run's
// parameters (schema.Tuning), so that two runs can say which settings they
// differ in however each command spelled them. It knows the engines' flags;
// what it cannot place it names, without values, for the run to report as
// unrecognized.
//
// What is left out on purpose is not unrecognized either: where the model
// is, which cards, the port, and the engine- or platform-level fixes the
// local engine record decides (D10, D11) -- --compilation-config,
// --enforce-eager, --tensor-parallel-size and the like.
package tuning

import (
	"sort"
	"strings"

	"github.com/NoobBandi/TenkStack/internal/schema"
)

// Flag is one launch flag as an engine build's own help describes it:
// every spelling, the environment variable that also sets it, and whether
// it takes a value. It mirrors what internal/flags reads from
// `llama-server --help`, which this package may not import.
type Flag struct {
	Names      []string
	Env        string
	TakesValue bool
}

// Engine keys as schema.EngineRef names them.
const (
	LlamaCpp = "llamacpp"
	VLLM     = "vllm"
	SGLang   = "sglang"
)

// Parse reads a launch command with the built-in flag tables. env is the
// entry's environment; only the variables an engine reads as flags count
// (llama.cpp's LLAMA_ARG_*), the rest -- the card selector, container
// names -- say nothing about tuning.
func Parse(cmd string, env map[string]string, engine string) (schema.Tuning, []string) {
	return ParseWith(cmd, env, engine, nil)
}

// ParseWith is Parse with the flags an installed llama-server reported for
// itself, so a spelling a newer build added is known without a release of
// this table. The built-in table still decides what each flag means; help
// only adds spellings, environment variables and whether a flag takes a
// value. It is ignored for engines other than llama.cpp.
func ParseWith(cmd string, env map[string]string, engine string, help []Flag) (schema.Tuning, []string) {
	d := dialectFor(engine, help)
	b := newBuilder(d)

	// llama.cpp reads its environment first and lets the command line
	// override it, so the variables go in first. Sorted so that two
	// variables naming one flag settle the same way every time.
	if len(d.env) > 0 {
		keys := make([]string, 0, len(env))
		for k := range env {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if s, ok := d.env[k]; ok {
				d.apply(b, s, "", env[k], true)
			}
		}
	}

	args := split(cmd)
	// The launcher comes first -- a macro, a script, `vllm serve` -- and a
	// positional argument after it is a model path or a port; neither is
	// a parameter.
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if !isFlag(arg) {
			continue
		}
		name, value, inline := strings.Cut(arg, "=")
		name, key := d.normalise(name)
		s, known := d.resolve(name)
		takes := !known || !d.bools[s.canonical]
		if !inline && takes && i+1 < len(args) && !isFlag(args[i+1]) {
			// The value is the next word unless that is a flag, which also
			// covers an optional one (-fa, -fa on). For a flag the table
			// has never seen this is a guess: positional arguments after
			// the launcher are rare, and swallowing one costs less than
			// reading every value of an unknown flag as an argument.
			value, inline = args[i+1], true
			i++
		}
		if !known {
			b.unknown(name + dotted(key))
			continue
		}
		d.apply(b, s, key, value, inline)
	}
	return b.finish(), b.unrecognized()
}

func dotted(key string) string {
	if key == "" {
		return ""
	}
	return "." + key
}

// isFlag tells a flag from a value; a negative number is a value.
func isFlag(s string) bool {
	if len(s) < 2 || s[0] != '-' {
		return false
	}
	c := s[1]
	return !(c >= '0' && c <= '9' || c == '.')
}

// split breaks a llama-swap cmd into words the way llama-swap does before
// it starts the process: comment lines dropped, a backslash at the end of
// a line joining it to the next, then shell quoting. A quoted JSON value
// may span lines.
func split(cmd string) []string {
	var lines []string
	for _, line := range strings.Split(cmd, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		lines = append(lines, line)
	}
	text := strings.ReplaceAll(strings.Join(lines, "\n"), "\\\n", " ")

	var out []string
	var cur strings.Builder
	inWord := false
	quote := byte(0)
	for i := 0; i < len(text); i++ {
		c := text[i]
		switch {
		case quote == '\'':
			if c == '\'' {
				quote = 0
			} else {
				cur.WriteByte(c)
			}
		case quote == '"':
			if c == '"' {
				quote = 0
			} else if c == '\\' && i+1 < len(text) && strings.IndexByte("\"\\$`", text[i+1]) >= 0 {
				i++
				cur.WriteByte(text[i])
			} else {
				cur.WriteByte(c)
			}
		case c == '\'' || c == '"':
			quote = c
			inWord = true
		case c == '\\' && i+1 < len(text):
			i++
			cur.WriteByte(text[i])
			inWord = true
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			if inWord {
				out = append(out, cur.String())
				cur.Reset()
				inWord = false
			}
		default:
			cur.WriteByte(c)
			inWord = true
		}
	}
	if inWord {
		out = append(out, cur.String())
	}
	return out
}
