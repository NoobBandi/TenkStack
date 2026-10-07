package profile

import (
	"strings"
)

// Split breaks a llama-swap cmd into words the way llama-swap hands them to
// the process: whitespace and newlines separate, single quotes are literal,
// double quotes allow backslash escapes, a backslash before a newline joins
// two lines, and a line starting with # is a comment. Quoting matters here
// because vLLM entries carry JSON in --speculative-config and
// --compilation-config, whose spaces must not split a word.
func Split(cmd string) []string {
	var out []string
	var word strings.Builder
	inWord := false
	lineStart := true
	flush := func() {
		if inWord {
			out = append(out, word.String())
			word.Reset()
			inWord = false
		}
	}
	runes := []rune(cmd)
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		switch {
		case r == '\n':
			flush()
			lineStart = true
			continue
		case r == ' ' || r == '\t' || r == '\r':
			flush()
			continue
		case r == '#' && !inWord && lineStart:
			for i < len(runes) && runes[i] != '\n' {
				i++
			}
			i--
			continue
		case r == '\'':
			inWord = true
			for i++; i < len(runes) && runes[i] != '\''; i++ {
				word.WriteRune(runes[i])
			}
		case r == '"':
			inWord = true
			for i++; i < len(runes) && runes[i] != '"'; i++ {
				if runes[i] == '\\' && i+1 < len(runes) && strings.ContainsRune(`"\$`+"`", runes[i+1]) {
					i++
				}
				word.WriteRune(runes[i])
			}
		case r == '\\' && i+1 < len(runes):
			i++
			if runes[i] != '\n' {
				inWord = true
				word.WriteRune(runes[i])
			}
		default:
			inWord = true
			word.WriteRune(r)
		}
		lineStart = false
	}
	flush()
	return out
}

// Flag is the value of the last of names on the command line, written as
// "--name value" or "--name=value"; the last because that is the one the
// engines' argument parsers keep.
func Flag(args []string, names ...string) (string, bool) {
	value, found := "", false
	for i, a := range args {
		for _, n := range names {
			switch {
			case a == n && i+1 < len(args):
				value, found = args[i+1], true
			case strings.HasPrefix(a, n+"="):
				value, found = strings.TrimPrefix(a, n+"="), true
			}
		}
	}
	return value, found
}

// Has says whether any of names appears as a switch.
func Has(args []string, names ...string) bool {
	for _, a := range args {
		for _, n := range names {
			if a == n || strings.HasPrefix(a, n+"=") {
				return true
			}
		}
	}
	return false
}
