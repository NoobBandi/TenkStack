package journal

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// level folds syslog priority into the three levels the UI colours.
func level(priority int) string {
	switch {
	case priority <= 3:
		return "error"
	case priority == 4:
		return "warn"
	}
	return "info"
}

// Caddy writes JSON with its own level field; journald stamps it all as 6.
var caddyLevel = map[string]string{
	"debug": "info", "info": "info", "warn": "warn",
	"error": "error", "panic": "error", "fatal": "error",
}

var (
	bracket    = regexp.MustCompile(`^\[(DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\]\s*`)
	pyPreamble = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[,.]\d+\s+(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\s+`)
	bareLevel  = regexp.MustCompile(`^(DEBUG|INFO|WARNING|WARN|ERROR|CRITICAL|FATAL)\s*:\s+`)
	statusJSON = regexp.MustCompile(`"status(?:Code)?"\s*:\s*"?(\d{3})"?`)
	statusCLF  = regexp.MustCompile(`"[A-Z]+ [^"]*HTTP/[\d.]+"\s+(\d{3})\b`)
	// Phrases that say a failure did not happen, so "errors: 0" is not an
	// error. The trailing group stands in for a lookahead.
	notAnError = regexp.MustCompile(`(?i)\b(?:error|err|errors|failed|failure|failures)\s*[:=]\s*(?:none|null|nil|false|0|no|-|""|'')([\s,;.)\]]|$)`)
	errorWords = regexp.MustCompile(`\berror\b|\bexception\b|\bfailed\b`)
	warnWords  = regexp.MustCompile(`\bwarn(?:ing)?\b`)
	ansi       = regexp.MustCompile(`\x1b\[[0-9;]*m`)
)

var wordToLevel = map[string]string{
	"debug": "info", "info": "info", "warning": "warn", "warn": "warn",
	"error": "error", "critical": "error", "fatal": "error",
}

// stripPreamble removes a leading timestamp and level, returning what they
// said. Only the head of the line is touched.
func stripPreamble(text string) (string, string) {
	if m := pyPreamble.FindStringSubmatchIndex(text); m != nil {
		return text[m[1]:], wordToLevel[strings.ToLower(text[m[2]:m[3]])]
	}
	if m := bareLevel.FindStringSubmatchIndex(text); m != nil {
		return text[m[1]:], wordToLevel[strings.ToLower(text[m[2]:m[3]])]
	}
	return text, ""
}

// statusLevel is the severity an HTTP status implies; 2xx is not promoted,
// or the ordinary case would hide the unusual lines.
func statusLevel(text string) string {
	m := statusJSON.FindStringSubmatch(text)
	if m == nil {
		m = statusCLF.FindStringSubmatch(text)
	}
	if m == nil {
		return ""
	}
	code, _ := strconv.Atoi(m[1])
	switch {
	case code >= 500:
		return "error"
	case code >= 400:
		return "warn"
	}
	return ""
}

// keywordLevel is the last resort for sources that declare nothing.
func keywordLevel(text string) string {
	scope := strings.ToLower(notAnError.ReplaceAllString(text, "$1"))
	if strings.Contains(scope, "traceback") || errorWords.MatchString(scope) {
		return "error"
	}
	if warnWords.MatchString(scope) {
		return "warn"
	}
	return "info"
}

// pyStr renders a value the way Python's str() would.
func pyStr(v any) string {
	switch x := v.(type) {
	case nil:
		return "None"
	case string:
		return x
	case bool:
		if x {
			return "True"
		}
		return "False"
	case json.Number:
		return x.String()
	case *omap:
		b, _ := json.Marshal(x)
		return string(b)
	default:
		return fmt.Sprint(x)
	}
}

// flatten turns nested structure into dotted key/value pairs, capped in
// depth so a Caddy request object does not become forty rows.
func flatten(v any, prefix string, depth int) [][2]string {
	var out [][2]string
	switch x := v.(type) {
	case *omap:
		if depth < 3 {
			for _, key := range x.keys {
				p := key
				if prefix != "" {
					p = prefix + "." + key
				}
				out = append(out, flatten(x.vals[key], p, depth+1)...)
			}
			return out
		}
	case []any:
		if depth < 3 {
			scalars := true
			for _, item := range x {
				switch item.(type) {
				case *omap, []any:
					scalars = false
				}
			}
			if scalars {
				parts := make([]string, len(x))
				for i, item := range x {
					parts[i] = pyStr(item)
				}
				return append(out, [2]string{prefix, strings.Join(parts, ", ")})
			}
			for i, item := range x {
				out = append(out, flatten(item, fmt.Sprintf("%s[%d]", prefix, i), depth+1)...)
			}
			return out
		}
	}
	return append(out, [2]string{prefix, pyStr(v)})
}

var consumed = map[string]bool{"level": true, "ts": true, "msg": true, "time": true, "message": true, "logger": true}

func upgrade(level, byStatus string) string {
	if byStatus != "" && (byStatus == "error" || level == "info") {
		return byStatus
	}
	return level
}

// structure splits a line into what to show, how bad it is, and what to
// hide behind it. fields is nil for a line without structure.
func structure(text, lvl string) (string, string, [][2]string) {
	stripped := strings.TrimLeft(text, " \t\r\n")

	if strings.HasPrefix(stripped, "{") {
		data, ok := parseOrdered(stripped)
		if !ok {
			return text, lvl, nil
		}
		if own, has := data.vals["level"]; has {
			if mapped, known := caddyLevel[strings.ToLower(pyStr(own))]; known {
				lvl = mapped
			}
		}
		lvl = upgrade(lvl, statusLevel(stripped))

		summary := ""
		if m, ok := data.vals["msg"]; ok && truthy(m) {
			summary = pyStr(m)
		} else if m, ok := data.vals["message"]; ok && truthy(m) {
			summary = pyStr(m)
		}
		if name, ok := data.vals["logger"]; ok && truthy(name) && summary != "" {
			summary = pyStr(name) + ": " + summary
		}
		var fields [][2]string
		for _, key := range data.keys {
			if consumed[key] {
				continue
			}
			fields = append(fields, flatten(data.vals[key], key, 0)...)
		}
		if summary == "" {
			summary = stripped
		}
		return summary, lvl, fields
	}

	without, declared := stripPreamble(stripped)
	if declared != "" {
		return without, upgrade(declared, statusLevel(without)), nil
	}

	if m := bracket.FindStringSubmatchIndex(stripped); m != nil {
		word := strings.ToLower(stripped[m[2]:m[3]])
		l := "info"
		switch {
		case word == "error" || word == "fatal":
			l = "error"
		case strings.HasPrefix(word, "warn"):
			l = "warn"
		}
		rest := stripped[m[1]:]
		return rest, upgrade(l, statusLevel(rest)), nil
	}

	if by := statusLevel(text); by != "" {
		return text, by, nil
	}
	return text, lvl, nil
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case string:
		return x != ""
	case bool:
		return x
	case json.Number:
		f, _ := x.Float64()
		return f != 0
	case []any:
		return len(x) > 0
	case *omap:
		return len(x.keys) > 0
	}
	return true
}

// omap is a JSON object with its key order kept, so the expanded view lists
// fields as the writer wrote them.
type omap struct {
	keys []string
	vals map[string]any
}

func (m *omap) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, k := range m.keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		kb, _ := json.Marshal(k)
		buf.Write(kb)
		buf.WriteByte(':')
		vb, err := json.Marshal(m.vals[k])
		if err != nil {
			return nil, err
		}
		buf.Write(vb)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

func parseOrdered(text string) (*omap, bool) {
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	v, err := decodeValue(dec)
	if err != nil {
		return nil, false
	}
	m, ok := v.(*omap)
	return m, ok
}

func decodeValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			m := &omap{vals: map[string]any{}}
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, _ := keyTok.(string)
				val, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				if _, dup := m.vals[key]; !dup {
					m.keys = append(m.keys, key)
				}
				m.vals[key] = val
			}
			_, err := dec.Token() // '}'
			return m, err
		case '[':
			list := []any{}
			for dec.More() {
				val, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				list = append(list, val)
			}
			_, err := dec.Token() // ']'
			return list, err
		}
		return nil, fmt.Errorf("unexpected delimiter %v", t)
	default:
		return tok, nil
	}
}
