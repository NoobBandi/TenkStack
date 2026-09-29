package httpapi

import (
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/NoobBandi/TenkStack/internal/api"
	"github.com/NoobBandi/TenkStack/internal/files"
)

// Every filesystem route takes require_owner: an API key is pasted into a
// chat client and travels, and one that also opens a file browser hands
// out more than whoever minted it meant to.

// fileError is the one translation from filesystem failures to statuses.
func fileError(w http.ResponseWriter, err error) {
	var (
		stale       *files.Stale
		tooBig      *files.TooBig
		denied      *files.Denied
		badPath     *files.BadPath
		exists      *files.Exists
		notFound    *files.NotFound
		notEmpty    *files.NotEmpty
		notDir      *files.NotDir
		notWritable *files.NotWritable
		mismatch    *files.UploadMismatch
	)
	switch {
	case errors.As(err, &stale):
		fail(w, http.StatusConflict, stale.Msg)
	case errors.As(err, &tooBig):
		fail(w, http.StatusRequestEntityTooLarge, tooBig.Msg)
	case errors.As(err, &denied):
		fail(w, http.StatusForbidden, denied.Msg)
	case errors.As(err, &badPath):
		fail(w, http.StatusBadRequest, badPath.Msg)
	case errors.As(err, &exists):
		fail(w, http.StatusConflict, exists.Error())
	case errors.As(err, &notFound):
		fail(w, http.StatusNotFound, notFound.Error())
	case errors.As(err, &notEmpty):
		fail(w, http.StatusConflict, notEmpty.Error())
	case errors.As(err, &notDir):
		fail(w, http.StatusBadRequest, notDir.Error())
	case errors.As(err, &notWritable):
		fail(w, http.StatusForbidden, notWritable.Error())
	case errors.As(err, &mismatch):
		fail(w, http.StatusBadRequest, mismatch.Msg)
	case errors.Is(err, os.ErrPermission):
		fail(w, http.StatusForbidden, err.Error()+" 不可寫入")
	default:
		fail(w, http.StatusInternalServerError, err.Error())
	}
}

// fsParams reads the query fields every route takes; a missing required
// one is 422, as FastAPI answers it.
func (s *Server) fsParams(w http.ResponseWriter, r *http.Request, required ...string) (map[string]string, bool) {
	if _, d := s.Auth.RequireOwner(r); d != nil {
		denied(w, d)
		return nil, false
	}
	q := r.URL.Query()
	out := map[string]string{}
	for _, key := range []string{"root", "path", "name", "to", "to_root", "to_path", "query"} {
		out[key] = q.Get(key)
	}
	for _, key := range required {
		if !q.Has(key) {
			fail(w, http.StatusUnprocessableEntity, key+" is required")
			return nil, false
		}
	}
	return out, true
}

func (s *Server) fsRoots(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.fsParams(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, api.FSRoots{Roots: s.Files.RootsInfo()})
}

func (s *Server) fsListing(w http.ResponseWriter, r *http.Request) {
	p, ok := s.fsParams(w, r, "root")
	if !ok {
		return
	}
	out, err := s.Files.Listing(p["root"], p["path"], queryBool(r, "hidden", false), p["query"], files.ListingLimit)
	if err != nil {
		fileError(w, err)
		return
	}
	if out.Entries != nil && out.Truncated == nil {
		// An absent directory answers the short shape.
		writeJSON(w, http.StatusOK, map[string]any{"entries": out.Entries, "writable": false, "free": 0})
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) fsLocate(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.fsParams(w, r, "path"); !ok {
		return
	}
	out, err := s.Files.Locate(r.URL.Query().Get("path"))
	if err != nil {
		fileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) fsTreeSize(w http.ResponseWriter, r *http.Request) {
	p, ok := s.fsParams(w, r, "root")
	if !ok {
		return
	}
	out, err := s.Files.TreeSize(p["root"], p["path"], p["name"])
	if err != nil {
		fileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) fsPeek(w http.ResponseWriter, r *http.Request) {
	p, ok := s.fsParams(w, r, "root", "name")
	if !ok {
		return
	}
	out, err := s.Files.Peek(p["root"], p["path"], p["name"])
	if err != nil {
		fileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Types the browser may render in place; everything else is a download,
// because an HTML file served inline from this origin is stored XSS.
var inlineTypes = []string{"image/", "video/", "audio/"}

func rawHeaders(h http.Header) {
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	h.Set("Cache-Control", "private, max-age=60")
}

// rfc5987 percent-encodes a filename the way Python's quote() does.
func rfc5987(name string) string {
	var b strings.Builder
	for _, c := range []byte(name) {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '.' || c == '-' || c == '~' || c == '/' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// fsRaw is the bytes with Range support: a video element will not let
// anyone drag the scrubber unless the server answers 206.
func (s *Server) fsRaw(w http.ResponseWriter, r *http.Request) {
	p, ok := s.fsParams(w, r, "root", "name")
	if !ok {
		return
	}
	target, size, err := s.Files.OpenFile(p["root"], p["path"], p["name"], queryBool(r, "partial", false))
	if err != nil {
		fileError(w, err)
		return
	}
	media := mime.TypeByExtension(filepath.Ext(target))
	if media == "" {
		media = "application/octet-stream"
	}
	inline := false
	for _, t := range inlineTypes {
		if strings.HasPrefix(media, t) {
			inline = true
		}
	}
	if queryBool(r, "download", false) {
		inline = false
	}
	disposition := "attachment"
	if inline {
		disposition = "inline"
	}
	h := w.Header()
	rawHeaders(h)
	h.Set("Accept-Ranges", "bytes")
	h.Set("Content-Disposition", disposition+"; filename*=UTF-8''"+rfc5987(filepath.Base(target)))
	h.Set("Content-Type", media)

	start, end := int64(0), size-1
	status := http.StatusOK
	if rng := r.Header.Get("Range"); strings.HasPrefix(rng, "bytes=") && size > 0 {
		spec := strings.TrimSpace(strings.SplitN(rng[6:], ",", 2)[0])
		first, last, _ := strings.Cut(spec, "-")
		var perr error
		switch {
		case first != "":
			start, perr = strconv.ParseInt(first, 10, 64)
			if perr == nil && last != "" {
				end, perr = strconv.ParseInt(last, 10, 64)
			}
		case last != "":
			var n int64
			n, perr = strconv.ParseInt(last, 10, 64)
			start = size - n
			if start < 0 {
				start = 0
			}
		default:
			perr = errors.New(spec)
		}
		if perr != nil {
			fail(w, http.StatusBadRequest, "Range 格式錯誤")
			return
		}
		if end > size-1 {
			end = size - 1
		}
		if start > end {
			h.Set("Content-Range", fmt.Sprintf("bytes */%d", size))
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return
		}
		status = http.StatusPartialContent
		h.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, size))
	}
	length := int64(0)
	if size > 0 {
		length = end - start + 1
	}
	h.Set("Content-Length", strconv.FormatInt(length, 10))
	f, err := os.Open(target)
	if err != nil {
		fileError(w, err)
		return
	}
	defer f.Close()
	w.WriteHeader(status)
	if r.Method == http.MethodHead || length == 0 {
		return
	}
	io.CopyN(w, io.NewSectionReader(f, start, length), length)
}

func (s *Server) fsThumb(w http.ResponseWriter, r *http.Request) {
	p, ok := s.fsParams(w, r, "root", "name")
	if !ok {
		return
	}
	if !files.CanThumbnail(p["name"]) {
		fail(w, http.StatusUnsupportedMediaType, "這個格式沒有縮圖")
		return
	}
	cached, err := s.Files.Thumbnail(p["root"], p["path"], p["name"])
	if err != nil {
		var unreadable *files.Unreadable
		if errors.As(err, &unreadable) {
			fail(w, http.StatusUnsupportedMediaType, "讀不出圖片："+unreadable.Msg)
			return
		}
		fileError(w, err)
		return
	}
	rawHeaders(w.Header())
	w.Header().Set("Content-Type", "image/webp")
	serveFile(w, r, cached, "private, max-age=86400")
}

func (s *Server) fsMkdir(w http.ResponseWriter, r *http.Request) {
	p, ok := s.fsParams(w, r, "root", "name")
	if !ok {
		return
	}
	out, err := s.Files.Mkdir(p["root"], p["path"], p["name"])
	if err != nil {
		fileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) fsReadText(w http.ResponseWriter, r *http.Request) {
	p, ok := s.fsParams(w, r, "root", "name")
	if !ok {
		return
	}
	out, err := s.Files.ReadText(p["root"], p["path"], p["name"])
	if err != nil {
		fileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) fsWriteText(w http.ResponseWriter, r *http.Request) {
	p, ok := s.fsParams(w, r, "root", "name")
	if !ok {
		return
	}
	var in struct {
		Text  *string  `json:"text"`
		Mtime *float64 `json:"mtime"`
	}
	if err := readJSON(r, &in); err != nil || in.Text == nil {
		fail(w, http.StatusUnprocessableEntity, "text is required")
		return
	}
	out, err := s.Files.WriteText(p["root"], p["path"], p["name"], *in.Text, in.Mtime)
	if err != nil {
		fileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) fsRename(w http.ResponseWriter, r *http.Request) {
	p, ok := s.fsParams(w, r, "root", "name", "to")
	if !ok {
		return
	}
	out, err := s.Files.Rename(p["root"], p["path"], p["name"], p["to"])
	if err != nil {
		fileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) fsMove(w http.ResponseWriter, r *http.Request) {
	p, ok := s.fsParams(w, r, "root", "name", "to_root")
	if !ok {
		return
	}
	out, err := s.Files.Move(p["root"], p["path"], p["name"], p["to_root"], p["to_path"])
	if err != nil {
		fileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) fsDelete(w http.ResponseWriter, r *http.Request) {
	p, ok := s.fsParams(w, r, "root", "name")
	if !ok {
		return
	}
	out, err := s.Files.Delete(p["root"], p["path"], p["name"], queryBool(r, "partial", false))
	if err != nil {
		fileError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) fsOffset(w http.ResponseWriter, r *http.Request) {
	p, ok := s.fsParams(w, r, "root", "name")
	if !ok {
		return
	}
	out, err := s.Files.UploadOffset(p["root"], p["path"], p["name"])
	if err != nil {
		fileError(w, err)
		return
	}
	if out.Exists {
		writeJSON(w, http.StatusOK, map[string]any{"offset": out.Offset, "exists": true, "size": out.Size})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"offset": out.Offset, "exists": false})
}

// fsUpload takes one chunk as a raw body, straight from the socket to the
// disk. A mismatched offset answers 409 with the length actually held.
func (s *Server) fsUpload(w http.ResponseWriter, r *http.Request) {
	p, ok := s.fsParams(w, r, "root", "name", "offset", "total")
	if !ok {
		return
	}
	offset, err1 := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
	total, err2 := strconv.ParseInt(r.URL.Query().Get("total"), 10, 64)
	if err1 != nil || err2 != nil {
		fail(w, http.StatusUnprocessableEntity, "offset and total must be integers")
		return
	}
	out, err := s.Files.Receive(p["root"], p["path"], p["name"], offset, total, r.Body)
	if err != nil {
		fileError(w, err)
		return
	}
	if ok, _ := out["ok"].(bool); !ok {
		writeJSON(w, http.StatusConflict, out)
		return
	}
	writeJSON(w, http.StatusOK, out)
}
