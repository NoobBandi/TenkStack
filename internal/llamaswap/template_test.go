package llamaswap

import (
	"slices"
	"testing"
)

// The lines of Qwen3.8-27B's chat template that read the effort.
const qwen38Effort = `{%- if enable_thinking is undefined or enable_thinking is true %}
    {%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}
    {%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}
        {{- raise_exception('Unexpected reasoning effort ' ~ reasoning_effort ~ '.') }}
    {%- endif %}
    {%- if resolved_reasoning_effort == 'xhigh' %}`

func TestReasoningEffortIn(t *testing.T) {
	got := ReasoningEffortIn(qwen38Effort)
	if got == nil || !slices.Equal(got.Levels, []string{"xhigh", "medium", "low"}) || got.Default != "xhigh" {
		t.Fatalf("got %+v", got)
	}
	// Without a validated list, the levels it compares against.
	got = ReasoningEffortIn(`{% if reasoning_effort == "high" %}a{% elif reasoning_effort == "low" %}b{% endif %}`)
	if got == nil || !slices.Equal(got.Levels, []string{"high", "low"}) || got.Default != "" {
		t.Fatalf("got %+v", got)
	}
	for _, tpl := range []string{"", "{{ messages }}", `{% if reasoning_effort == 'low' %}`} {
		if got := ReasoningEffortIn(tpl); got != nil {
			t.Errorf("%q should take no effort, got %+v", tpl, got)
		}
	}
}

func TestTemplateSources(t *testing.T) {
	if got := expandMacros("${dir}/t.j2", map[string]string{"dir": "${root}/templates", "root": "/srv"}); got != "/srv/templates/t.j2" {
		t.Errorf("nested macros: %q", got)
	}
	if got := tokenizerTemplate([]byte(`{"chat_template": "{{ x }}"}`)); got != "{{ x }}" {
		t.Errorf("string template: %q", got)
	}
	if got := tokenizerTemplate([]byte(`{"chat_template": [{"name": "tool_use", "template": "a"}, {"name": "default", "template": "b"}]}`)); got != "b" {
		t.Errorf("named templates: %q", got)
	}
	// The kwargs flags are not a template.
	if m := templateFlag.FindStringSubmatch("--default-chat-template-kwargs '{}'\n--chat-template-kwargs x"); m != nil {
		t.Errorf("matched %q", m[1])
	}
	if m := templateFlag.FindStringSubmatch("--jinja\n--chat-template-file ${qwen38-template}\n"); m == nil || m[1] != "${qwen38-template}" {
		t.Errorf("file flag: %v", m)
	}
}
