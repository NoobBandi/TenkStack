package httpapi

import (
	"fmt"
	"net/http"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
	"github.com/NoobBandi/TenkStack/server-go/internal/gguf"
)

func (s *Server) catalogSearch(w http.ResponseWriter, r *http.Request) {
	limit, ok := queryInt(w, r, "limit", 100)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, s.Catalog.Search(r.Context(), r.URL.Query().Get("q"), limit))
}

func (s *Server) catalogFiles(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.Catalog.ListFiles(r.Context(), r.URL.Query().Get("repo_id")))
}

// catalogEstimate reads a GGUF's header over HTTP and estimates how fast
// it would generate here. A POST because a split model's parts are a list.
func (s *Server) catalogEstimate(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RepoID    string `json:"repo_id"`
		Parts     []any  `json:"parts"`
		SizeBytes any    `json:"size_bytes"`
	}
	if err := readJSON(r, &in); err != nil {
		fail(w, http.StatusUnprocessableEntity, "invalid JSON body")
		return
	}
	if in.RepoID == "" || len(in.Parts) == 0 {
		fail(w, http.StatusBadRequest, "repo_id and parts are required")
		return
	}
	parts := make([]string, len(in.Parts))
	for i, p := range in.Parts {
		parts[i] = fmt.Sprint(p)
	}
	head := s.Remote.Describe(r.Context(), in.RepoID, parts)
	if head == nil {
		fail(w, http.StatusBadGateway, "could not read the GGUF header")
		return
	}
	var size int64
	if f, ok := in.SizeBytes.(float64); ok {
		size = int64(f)
	}
	byType := map[string]int64{}
	for k, v := range head.ByType {
		byType[k] = v
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"estimate":          gguf.EstimateSpeed(head, size, s.Settings.Get("estimate_depth")),
		"architecture":      head.Architecture,
		"layers":            head.Layers,
		"attention_layers":  head.AttentionLayers,
		"expert_count":      head.ExpertCount,
		"expert_used_count": head.ExpertUsedCount,
		"context_length":    head.ContextLength,
		"mtp":               head.MTP,
		"by_type":           byType,
	})
}

func (s *Server) catalogDownload(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RepoID   string `json:"repo_id"`
		Filename string `json:"filename"`
	}
	if err := readJSON(r, &in); err != nil || in.RepoID == "" || in.Filename == "" {
		fail(w, http.StatusBadRequest, "repo_id and filename are required")
		return
	}
	writeJSON(w, http.StatusOK, s.Catalog.Start(in.RepoID, in.Filename))
}

func (s *Server) catalogCancel(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RepoID   string `json:"repo_id"`
		Filename string `json:"filename"`
	}
	if err := readJSON(r, &in); err != nil {
		fail(w, http.StatusUnprocessableEntity, "invalid JSON body")
		return
	}
	writeJSON(w, http.StatusOK, api.OK{OK: s.Catalog.Cancel(in.RepoID, in.Filename)})
}

func (s *Server) catalogDownloads(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.Catalog.Status())
}
