package tuning

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"

	"github.com/NoobBandi/TenkStack/internal/schema"
)

// canonical is a Tuning as a JSON tree in one form only: empty objects and
// nulls dropped, speculation methods sorted. Two Tunings that set the
// same parameters then give the same tree whichever way they were built --
// an empty KVCache and none at all, ["ngram","mtp"] and ["mtp","ngram"].
func canonical(t schema.Tuning) map[string]any {
	raw, err := json.Marshal(t)
	if err != nil {
		// Every field is a plain value; only a bug gets here.
		panic(err)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	// Numbers stay as written, so 0.95 is rendered 0.95 and not a float's
	// nearest neighbour.
	dec.UseNumber()
	var tree map[string]any
	if err := dec.Decode(&tree); err != nil {
		panic(err)
	}
	if spec, ok := tree["speculative"].(map[string]any); ok {
		if methods, ok := spec["methods"].([]any); ok {
			sort.Slice(methods, func(i, j int) bool { return methods[i].(string) < methods[j].(string) })
		}
	}
	prune(tree)
	return tree
}

// prune drops nulls and empty objects, deepest first.
func prune(m map[string]any) {
	for k, v := range m {
		switch x := v.(type) {
		case nil:
			delete(m, k)
		case map[string]any:
			prune(x)
			if len(x) == 0 {
				delete(m, k)
			}
		}
	}
}

// Hash is a short, stable name for a set of parameters: equal Tunings
// hash equal regardless of the flag order or spellings they came from.
// encoding/json writes map keys sorted, which is what makes it stable.
func Hash(t schema.Tuning) string {
	raw, err := json.Marshal(canonical(t))
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:8])
}

// Change is one parameter two runs set differently. Field is the dotted
// JSON path ("kv_cache.type_k"); A and B are the values, "" where unset.
type Change struct {
	Field string `json:"field"`
	A     string `json:"a"`
	B     string `json:"b"`
}

// Diff lists the parameters that differ between a and b, sorted by field.
func Diff(a, b schema.Tuning) []Change {
	fa, fb := map[string]string{}, map[string]string{}
	flatten("", canonical(a), fa)
	flatten("", canonical(b), fb)
	fields := map[string]bool{}
	for f := range fa {
		fields[f] = true
	}
	for f := range fb {
		fields[f] = true
	}
	var out []Change
	for f := range fields {
		if fa[f] != fb[f] {
			out = append(out, Change{Field: f, A: fa[f], B: fb[f]})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Field < out[j].Field })
	return out
}

// flatten writes each leaf under its dotted path. A list is one value,
// "mtp,ngram" or "6,5": its order is part of what it says.
func flatten(prefix string, v any, out map[string]string) {
	switch x := v.(type) {
	case map[string]any:
		for k, child := range x {
			p := k
			if prefix != "" {
				p = prefix + "." + k
			}
			flatten(p, child, out)
		}
	default:
		out[prefix] = render(x)
	}
}

func render(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case json.Number:
		return x.String()
	case bool:
		if x {
			return "true"
		}
		return "false"
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			parts[i] = render(e)
		}
		return strings.Join(parts, ",")
	case nil:
		return ""
	}
	raw, _ := json.Marshal(v)
	return string(raw)
}
