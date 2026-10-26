package httpapi

import (
	"errors"
	"fmt"
	"mime"
	"net/http"
	"path"

	"github.com/NoobBandi/TenkStack/internal/api"
	"github.com/NoobBandi/TenkStack/internal/sandbox"
)

func sandboxError(w http.ResponseWriter, err error) {
	var (
		invalid     *sandbox.Invalid
		unavailable *sandbox.Unavailable
		busy        *sandbox.Busy
	)
	switch {
	case errors.As(err, &invalid):
		fail(w, http.StatusBadRequest, invalid.Msg)
	case errors.As(err, &unavailable):
		fail(w, http.StatusServiceUnavailable, unavailable.Msg)
	case errors.As(err, &busy):
		fail(w, http.StatusTooManyRequests, busy.Msg)
	case errors.Is(err, sandbox.ErrNotFound):
		fail(w, http.StatusNotFound, "找不到這個檔案：這段對話的沙箱可能已經閒置太久被收掉了")
	default:
		fail(w, http.StatusInternalServerError, err.Error())
	}
}

// readSandbox is whether the agent's Python runs here. Anyone signed in
// may ask: the chat reads it to choose where to run.
func (s *Server) readSandbox(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := s.caller(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, s.Sandbox.Status(r.Context()))
}

// buildSandbox makes the image. Owner-only, like everything that builds or
// pulls one.
func (s *Server) buildSandbox(w http.ResponseWriter, r *http.Request) {
	if !s.owner(w, r) {
		return
	}
	out, err := s.Sandbox.Build(r.Context())
	if err != nil {
		sandboxError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) removeSandbox(w http.ResponseWriter, r *http.Request) {
	if !s.owner(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, s.Sandbox.Remove(r.Context()))
}

// runSandbox runs one call in the caller's own container for the session.
// The container is named after the caller as well as the session, so one
// person's session id never reaches another's namespace.
func (s *Server) runSandbox(w http.ResponseWriter, r *http.Request) {
	uid, _, ok := s.caller(w, r)
	if !ok {
		return
	}
	var in struct {
		Session string `json:"session"`
		Code    string `json:"code"`
	}
	if err := readJSON(r, &in); err != nil {
		fail(w, http.StatusUnprocessableEntity, "session and code are required")
		return
	}
	out, err := s.Sandbox.Run(r.Context(), uid, in.Session, in.Code)
	if err != nil {
		sandboxError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) resetSandbox(w http.ResponseWriter, r *http.Request) {
	uid, _, ok := s.caller(w, r)
	if !ok {
		return
	}
	var in struct {
		Session string `json:"session"`
	}
	if err := readJSON(r, &in); err != nil {
		fail(w, http.StatusUnprocessableEntity, "session is required")
		return
	}
	if err := s.Sandbox.Reset(r.Context(), uid, in.Session); err != nil {
		sandboxError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, api.OK{OK: true})
}

// sandboxFile hands over a file a call wrote. Always as a download, never
// rendered: an HTML file the model wrote must not run on the console's
// origin, where it would have the reader's session.
func (s *Server) sandboxFile(w http.ResponseWriter, r *http.Request) {
	uid, _, ok := s.caller(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	data, err := s.Sandbox.ReadFile(r.Context(), uid, q.Get("session"), q.Get("path"))
	if err != nil {
		sandboxError(w, err)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": path.Base(q.Get("path"))}))
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Length", fmt.Sprint(len(data)))
	_, _ = w.Write(data)
}
