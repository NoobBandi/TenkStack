// Package images re-encodes what llama.cpp cannot decode. Its stb_image
// reads JPEG, PNG, GIF and BMP; a WebP arrives as bytes it cannot parse and
// the error names neither the format nor the field. A format it reads is
// passed through untouched.
package images

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"log"
	"sort"
	"strings"

	_ "golang.org/x/image/webp"
)

const (
	headB64  = 32       // 32 base64 chars decode to 24 bytes
	maxBytes = 32 << 20 // a frame larger than this is not a screenshot
)

// sniff names the container from its magic bytes, or "".
func sniff(head []byte) string {
	switch {
	case bytes.HasPrefix(head, []byte("\x89PNG\r\n\x1a\n")):
		return "png"
	case bytes.HasPrefix(head, []byte("\xff\xd8\xff")):
		return "jpeg"
	case bytes.HasPrefix(head, []byte("GIF87a")) || bytes.HasPrefix(head, []byte("GIF89a")):
		return "gif"
	case bytes.HasPrefix(head, []byte("BM")):
		return "bmp"
	case len(head) >= 12 && string(head[:4]) == "RIFF" && string(head[8:12]) == "WEBP":
		return "webp"
	case len(head) >= 12 && string(head[4:8]) == "ftyp":
		// heic, heif, avif and friends all announce themselves this way.
		if brand := strings.TrimSpace(string(head[8:12])); brand != "" {
			return brand
		}
		return "iso-bmff"
	}
	if t := bytes.TrimLeft(head, " \t\r\n"); bytes.HasPrefix(t, []byte("<?xml")) || bytes.HasPrefix(t, []byte("<svg ")) {
		return "svg"
	}
	return ""
}

var passthrough = map[string]bool{"png": true, "jpeg": true, "gif": true, "bmp": true}

func decodeLenient(s string) ([]byte, error) {
	s = strings.Map(func(r rune) rune {
		if r == ' ' || r == '\n' || r == '\r' || r == '\t' {
			return -1
		}
		return r
	}, s)
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.RawStdEncoding.DecodeString(strings.TrimRight(s, "="))
}

func toPNG(raw []byte) []byte {
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		log.Printf("cannot convert image: %v", err)
		return nil
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		return nil
	}
	return out.Bytes()
}

// convert re-encodes one base64 image, returning the new base64 and the
// original format, or "" to leave it alone.
func convert(payload string) (string, string) {
	n := headB64
	if len(payload) < n {
		n = len(payload)
	}
	head, err := decodeLenient(payload[:n])
	if err != nil {
		return "", ""
	}
	kind := sniff(head)
	if kind == "" || passthrough[kind] {
		return "", ""
	}
	if len(payload)/4*3 > maxBytes {
		log.Printf("image too large to convert: %s, %d B64 chars", kind, len(payload))
		return "", ""
	}
	raw, err := decodeLenient(payload)
	if err != nil {
		return "", ""
	}
	out := toPNG(raw)
	if out == nil {
		return "", ""
	}
	return base64.StdEncoding.EncodeToString(out), kind
}

// walk rewrites every image in the tree, whatever shape the client wraps
// it in: OpenAI's image_url, a tool output, Anthropic's base64 source.
func walk(node any, seen *[]string) any {
	switch x := node.(type) {
	case map[string]any:
		if source, ok := x["source"].(map[string]any); ok && source["type"] == "base64" {
			if data, ok := source["data"].(string); ok {
				if converted, kind := convert(data); converted != "" {
					*seen = append(*seen, kind)
					newSource := map[string]any{}
					for k, v := range source {
						newSource[k] = v
					}
					newSource["data"] = converted
					newSource["media_type"] = "image/png"
					out := map[string]any{}
					for k, v := range x {
						out[k] = v
					}
					out["source"] = newSource
					return out
				}
			}
		}
		out := map[string]any{}
		for k, v := range x {
			out[k] = walk(v, seen)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, item := range x {
			out[i] = walk(item, seen)
		}
		return out
	case string:
		if strings.HasPrefix(x, "data:") && strings.Contains(x, ";base64,") {
			prefix, payload, _ := strings.Cut(x, ";base64,")
			if converted, kind := convert(payload); converted != "" {
				*seen = append(*seen, kind)
				head, _, _ := strings.Cut(prefix, ":")
				return head + ":image/png;base64," + converted
			}
		}
	}
	return node
}

// Transcode returns body with any image llama.cpp cannot read re-encoded
// as PNG, and unchanged when nothing was converted.
func Transcode(body []byte) []byte {
	if !bytes.Contains(body, []byte("base64")) {
		return body
	}
	var payload any
	if json.Unmarshal(body, &payload) != nil {
		return body
	}
	var seen []string
	rewritten := walk(payload, &seen)
	if len(seen) == 0 {
		return body
	}
	kinds := map[string]bool{}
	for _, k := range seen {
		kinds[k] = true
	}
	names := make([]string, 0, len(kinds))
	for k := range kinds {
		names = append(names, k)
	}
	sort.Strings(names)
	log.Printf("converted %d image(s) to PNG for llama.cpp: %s", len(seen), strings.Join(names, ", "))
	out, err := json.Marshal(rewritten)
	if err != nil {
		return body
	}
	return out
}
