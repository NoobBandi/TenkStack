package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const (
	// Vite fingerprints every asset, so a name can never change content.
	immutable = "public, max-age=31536000, immutable"
	// The shell carries the hashed names of the current bundle and must be
	// revalidated, or a deployment silently never arrives.
	revalidate = "no-cache, must-revalidate"
)

var cjkFontCandidates = []string{
	"/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
	"/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
	"/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
}

func (s *Server) cjkFont(w http.ResponseWriter, r *http.Request) {
	for _, p := range cjkFontCandidates {
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() {
			w.Header().Set("Content-Type", "font/ttf")
			w.Header().Set("Access-Control-Allow-Origin", "*")
			serveFile(w, r, p, immutable)
			return
		}
	}
	fail(w, http.StatusNotFound, "這台機器上沒有找到 CJK 字型")
}

func (s *Server) assets() http.Handler {
	dir := filepath.Join(s.WebDist, "assets")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := s.inside(dir, strings.TrimPrefix(r.URL.Path, "/assets/"))
		if !ok {
			fail(w, http.StatusNotFound, "Not Found")
			return
		}
		serveFile(w, r, p, immutable)
	})
}

// spa serves a real file when there is one, otherwise the shell.
func (s *Server) spa(w http.ResponseWriter, r *http.Request) {
	if rel := strings.TrimPrefix(r.URL.Path, "/"); rel != "" {
		if p, ok := s.inside(s.WebDist, rel); ok {
			serveFile(w, r, p, revalidate)
			return
		}
	}
	serveFile(w, r, filepath.Join(s.WebDist, "index.html"), revalidate)
}

// inside resolves rel under root and reports whether it is a regular file
// that really sits under root once symlinks and `..` are accounted for.
func (s *Server) inside(root, rel string) (string, bool) {
	rootReal, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", false
	}
	p, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		return "", false
	}
	if p != rootReal && !strings.HasPrefix(p, rootReal+string(filepath.Separator)) {
		return "", false
	}
	st, err := os.Stat(p)
	if err != nil || !st.Mode().IsRegular() {
		return "", false
	}
	return p, true
}

func serveFile(w http.ResponseWriter, r *http.Request, path, cacheControl string) {
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", cacheControl)
	http.ServeContent(w, r, st.Name(), st.ModTime(), f)
}
