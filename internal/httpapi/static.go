package httpapi

import (
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
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

// openSite opens one file of the frontend: from the directory when one is
// configured, otherwise from the copy embedded in the binary. A directory
// entry is looked up on the resolved path, so `..` and a symlink out of
// the tree are refused.
func (s *Server) openSite(rel string) (io.ReadSeeker, fs.FileInfo, bool) {
	rel = strings.TrimPrefix(path.Clean("/"+rel), "/")
	if s.WebDist != "" {
		p, ok := inside(s.WebDist, rel)
		if !ok {
			return nil, nil, false
		}
		f, err := os.Open(p)
		if err != nil {
			return nil, nil, false
		}
		st, err := f.Stat()
		if err != nil {
			f.Close()
			return nil, nil, false
		}
		return f, st, true
	}
	if s.Embedded == nil || !fs.ValidPath(rel) {
		return nil, nil, false
	}
	f, err := s.Embedded.Open(rel)
	if err != nil {
		return nil, nil, false
	}
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		f.Close()
		return nil, nil, false
	}
	rs, ok := f.(io.ReadSeeker)
	if !ok {
		f.Close()
		return nil, nil, false
	}
	return rs, st, true
}

func (s *Server) serveSite(w http.ResponseWriter, r *http.Request, rel, cacheControl string) bool {
	f, st, ok := s.openSite(rel)
	if !ok {
		return false
	}
	if c, ok := f.(io.Closer); ok {
		defer c.Close()
	}
	w.Header().Set("Cache-Control", cacheControl)
	modTime := st.ModTime()
	if modTime.IsZero() {
		modTime = s.Started
	}
	http.ServeContent(w, r, st.Name(), modTime, f)
	return true
}

func (s *Server) assets() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rel := strings.TrimPrefix(r.URL.Path, "/")
		if strings.HasSuffix(rel, "/") || !s.serveSite(w, r, rel, immutable) {
			fail(w, http.StatusNotFound, "Not Found")
		}
	})
}

// spa serves a real file when there is one, otherwise the shell.
func (s *Server) spa(w http.ResponseWriter, r *http.Request) {
	if rel := strings.TrimPrefix(r.URL.Path, "/"); rel != "" && s.serveSite(w, r, rel, revalidate) {
		return
	}
	if !s.serveSite(w, r, "index.html", revalidate) {
		fail(w, http.StatusNotFound, "前端還沒 build：跑 scripts/build.sh，或用 CONSOLE_WEB_DIST 指向 web/dist")
	}
}

// inside resolves rel under root and reports whether it is a regular file
// that really sits under root once symlinks and `..` are accounted for.
func inside(root, rel string) (string, bool) {
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
