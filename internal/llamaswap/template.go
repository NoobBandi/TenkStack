package llamaswap

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/NoobBandi/TenkStack/internal/api"
)

// How hard a model thinks is a chat template variable for the models that
// have one: Qwen3.8's template reads `reasoning_effort` (xhigh, medium or
// low, xhigh when unsaid) and turns it into a line of the system prompt. The
// levels are read from the template rather than listed per family, so a
// template that adds or renames one is offered as it is.
var (
	effortChoices = regexp.MustCompile(`reasoning_effort\s+not\s+in\s+[(\[]([^)\]]*)[)\]]`)
	effortCompare = regexp.MustCompile(`reasoning_effort\s*==\s*['"]([\w-]+)['"]`)
	effortDefault = regexp.MustCompile(`reasoning_effort\s*\|\s*default\(\s*['"]([\w-]+)['"]`)
	quoted        = regexp.MustCompile(`['"]([\w-]+)['"]`)
)

// ReasoningEffortIn is the reasoning_effort a chat template takes, or nil
// when it takes none.
func ReasoningEffortIn(template string) *api.ReasoningEffort {
	if !strings.Contains(template, "reasoning_effort") {
		return nil
	}
	var levels []string
	add := func(level string) {
		for _, l := range levels {
			if l == level {
				return
			}
		}
		levels = append(levels, level)
	}
	// The list the template validates against is the whole set, in its order;
	// the comparisons are a fallback for a template that does not validate.
	if m := effortChoices.FindStringSubmatch(template); m != nil {
		for _, q := range quoted.FindAllStringSubmatch(m[1], -1) {
			add(q[1])
		}
	}
	if len(levels) == 0 {
		for _, m := range effortCompare.FindAllStringSubmatch(template, -1) {
			add(m[1])
		}
	}
	if len(levels) < 2 {
		return nil
	}
	out := &api.ReasoningEffort{Levels: levels}
	if m := effortDefault.FindStringSubmatch(template); m != nil {
		out.Default = m[1]
	}
	return out
}

// A template given on the command line: llama-server's --chat-template-file,
// or vLLM's and SGLang's --chat-template, which take a path.
var templateFlag = regexp.MustCompile(`(?:^|\s)--chat-template(?:-file)?(?:\s+|=)(\S+)`)

var macroRef = regexp.MustCompile(`\$\{([^}]+)\}`)

func expandMacros(s string, macros map[string]string) string {
	for range 5 {
		next := macroRef.ReplaceAllStringFunc(s, func(ref string) string {
			if v, ok := macros[ref[2:len(ref)-1]]; ok {
				return v
			}
			return ref
		})
		if next == s {
			break
		}
		s = next
	}
	return s
}

// templateOf is the chat template an entry starts with, when it can be read
// from here: the file its command names, or the one its weights folder
// ships. A GGUF carries its own inside the file, which a running
// llama-server reports instead.
func (m *Models) templateOf(e modelEntry, macros map[string]string) string {
	if mm := templateFlag.FindStringSubmatch(e.cmd); mm != nil {
		p := expandMacros(strings.Trim(mm[1], `'"`), macros)
		if filepath.IsAbs(p) {
			if raw, err := os.ReadFile(p); err == nil {
				return string(raw)
			}
		}
	}
	for _, dir := range dirsInCmd(e.cmd) {
		p := m.resolve(dir)
		if p == "" {
			continue
		}
		if raw, err := os.ReadFile(filepath.Join(p, "chat_template.jinja")); err == nil {
			return string(raw)
		}
		if raw, err := os.ReadFile(filepath.Join(p, "tokenizer_config.json")); err == nil {
			return tokenizerTemplate(raw)
		}
	}
	return ""
}

// tokenizerTemplate is the default chat template a tokenizer_config.json
// holds: a string, or a list of named templates.
func tokenizerTemplate(raw []byte) string {
	var cfg struct {
		Template json.RawMessage `json:"chat_template"`
	}
	if json.Unmarshal(raw, &cfg) != nil || len(cfg.Template) == 0 {
		return ""
	}
	var one string
	if json.Unmarshal(cfg.Template, &one) == nil {
		return one
	}
	var named []struct {
		Name     string `json:"name"`
		Template string `json:"template"`
	}
	if json.Unmarshal(cfg.Template, &named) == nil {
		for _, n := range named {
			if n.Name == "default" {
				return n.Template
			}
		}
	}
	return ""
}

// ReasoningEfforts is, per entry, the reasoning_effort its chat template
// takes. Entries whose template takes none, or cannot be read from here,
// are absent.
func (m *Models) ReasoningEfforts() map[string]*api.ReasoningEffort {
	out := map[string]*api.ReasoningEffort{}
	entries, c, err := m.entries()
	if err != nil {
		return out
	}
	macros := Macros(c)
	for _, e := range entries {
		if effort := ReasoningEffortIn(m.templateOf(e, macros)); effort != nil {
			out[e.id] = effort
		}
	}
	return out
}
