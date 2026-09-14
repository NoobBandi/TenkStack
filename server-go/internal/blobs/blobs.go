// Package blobs keeps images on disk, addressed by their contents. The same
// image stored twice costs once, and because the name is the content a
// stored blob can never change, so it is served with a year's cache.
package blobs

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	// A reference is `blob:` and 64 hex characters, deliberately not a path.
	Ref     = regexp.MustCompile(`^blob:([0-9a-f]{64})$`)
	dataURI = regexp.MustCompile(`(?s)^data:([\w.+-]+/[\w.+-]+);base64,(.+)$`)
)

var suffixes = map[string]string{
	"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
	"image/gif": ".gif", "image/svg+xml": ".svg", "image/avif": ".avif",
}

var media = func() map[string]string {
	m := map[string]string{}
	for k, v := range suffixes {
		m[v] = k
	}
	return m
}()

type Store struct {
	Dir string
}

func New(dir string) *Store { return &Store{Dir: dir} }

func (s *Store) existing(digest string) string {
	matches, _ := filepath.Glob(filepath.Join(s.Dir, digest[:2], digest+".*"))
	if len(matches) == 0 {
		return ""
	}
	return matches[0]
}

// Put writes one data URI to disk and returns its reference, or "" for
// anything that is not a base64 data URI.
func (s *Store) Put(dataURL string) string {
	m := dataURI.FindStringSubmatch(strings.TrimSpace(dataURL))
	if m == nil {
		return ""
	}
	mediaType, encoded := m[1], m[2]
	raw, err := base64.StdEncoding.DecodeString(strings.Map(func(r rune) rune {
		if r == ' ' || r == '\n' || r == '\r' || r == '\t' {
			return -1
		}
		return r
	}, encoded))
	if err != nil {
		if raw, err = base64.RawStdEncoding.DecodeString(strings.TrimRight(encoded, "=")); err != nil {
			log.Printf("could not decode a data URI of %d characters", len(encoded))
			return ""
		}
	}
	sum := sha256.Sum256(raw)
	digest := hex.EncodeToString(sum[:])
	if s.existing(digest) == "" {
		suffix, ok := suffixes[mediaType]
		if !ok {
			suffix = ".bin"
		}
		path := filepath.Join(s.Dir, digest[:2], digest+suffix)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return ""
		}
		// Written beside and renamed, so a reader never opens a half-written
		// file under a name that promises those contents.
		tmp := path + ".part"
		if err := os.WriteFile(tmp, raw, 0o644); err != nil {
			return ""
		}
		if err := os.Rename(tmp, path); err != nil {
			return ""
		}
	}
	return "blob:" + digest
}

// Resolve is the file and media type behind a reference, or "" if gone.
func (s *Store) Resolve(reference string) (string, string) {
	m := Ref.FindStringSubmatch(strings.TrimSpace(reference))
	if m == nil {
		return "", ""
	}
	path := s.existing(m[1])
	if path == "" {
		return "", ""
	}
	mediaType, ok := media[filepath.Ext(path)]
	if !ok {
		mediaType = "application/octet-stream"
	}
	return path, mediaType
}

// ToRefs stores what can be stored and passes through what cannot.
func (s *Store) ToRefs(images []string) []string {
	out := make([]string, 0, len(images))
	for _, image := range images {
		if ref := s.Put(image); ref != "" {
			out = append(out, ref)
		} else {
			out = append(out, image)
		}
	}
	return out
}

// ToURLs turns references into URLs a browser can put in an img src;
// anything else is returned untouched.
func (s *Store) ToURLs(images []string) []string {
	out := make([]string, 0, len(images))
	for _, image := range images {
		if m := Ref.FindStringSubmatch(strings.TrimSpace(image)); m != nil {
			out = append(out, "/api/blobs/"+m[1])
		} else {
			out = append(out, image)
		}
	}
	return out
}
