// Package locations names model locations: the directories models are
// downloaded to and read from, at most five.
//
// Each is a llama-swap macro -- models-dir, the one every entry has always
// used, and models-dir-2 to models-dir-5 -- so an entry names a file in
// another location exactly the way llama-swap reads it:
// ${models-dir-2}/owner/repo/x. A file is identified the same way
// throughout the console: in the primary location by its path relative to
// it, as before, so nothing written before there was a choice changes;
// elsewhere by the macro form.
package locations

import (
	"fmt"
	"regexp"
)

const (
	Primary = "models-dir"
	Max     = 5
)

// Formats a location can be the default download target for: GGUF for
// llama.cpp, safetensors for vLLM.
var Formats = []string{"gguf", "safetensors"}

// Pattern matches a name in another location, capturing its key and the
// path within it.
var Pattern = regexp.MustCompile(`^\$\{(models-dir(?:-[2-5])?)\}/(.+)$`)

// Location is one model directory, by the macro that names it.
type Location struct {
	Key  string
	Path string
}

// Keys is every key a location can have, the primary first.
func Keys() []string {
	out := []string{Primary}
	for n := 2; n <= Max; n++ {
		out = append(out, fmt.Sprintf("%s-%d", Primary, n))
	}
	return out
}

// Ref is how a model entry names rel in the location key.
func Ref(key, rel string) string {
	if key == "" || key == Primary {
		return rel
	}
	return "${" + key + "}/" + rel
}

// Split is Ref's inverse: the location a name is in, and the path within.
func Split(ref string) (key, rel string) {
	if m := Pattern.FindStringSubmatch(ref); m != nil {
		return m[1], m[2]
	}
	return Primary, ref
}

// CmdPath is a name as a cmd writes it: always through the macro.
func CmdPath(ref string) string {
	key, rel := Split(ref)
	return "${" + key + "}/" + rel
}
