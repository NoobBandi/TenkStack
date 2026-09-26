// Package hftoken keeps the owner's Hugging Face access token, which the
// catalog sends to reach gated models (Llama, Gemma, …) once the owner has
// accepted their terms on the Hub. It lives in a file only the console's
// user can read, and nothing hands it back out: the API shows who it
// belongs to and its last four characters.
package hftoken

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type Store struct {
	Path string
	// Hub is Hugging Face's address; a test points it elsewhere.
	Hub string

	mu     sync.Mutex
	cached *string
}

func New(path string) *Store { return &Store{Path: path, Hub: "https://huggingface.co"} }

// Get is the token, or "" when none is set.
func (s *Store) Get() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cached == nil {
		raw, _ := os.ReadFile(s.Path)
		t := strings.TrimSpace(string(raw))
		s.cached = &t
	}
	return *s.cached
}

// Set keeps a token, readable by the console's user alone.
func (s *Store) Set(token string) error {
	token = strings.TrimSpace(token)
	s.mu.Lock()
	defer s.mu.Unlock()
	tmp := s.Path + ".tmp"
	if err := os.WriteFile(tmp, []byte(token+"\n"), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.Path); err != nil {
		return err
	}
	s.cached = &token
	return nil
}

// Clear forgets the token.
func (s *Store) Clear() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	empty := ""
	s.cached = &empty
	if err := os.Remove(s.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// Hint is how the token is shown: its last four characters.
func Hint(token string) string {
	if len(token) <= 4 {
		return strings.Repeat("•", len(token))
	}
	return "hf_…" + token[len(token)-4:]
}

// Invalid is a token the Hub does not accept.
type Invalid struct{ Status int }

func (e *Invalid) Error() string {
	return fmt.Sprintf("Hugging Face 不接受這個 token（HTTP %d）：確認有複製完整、沒有過期，權限至少要 Read", e.Status)
}

// WhoAmI asks the Hub whose token it is.
func (s *Store) WhoAmI(ctx context.Context, token string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, s.Hub+"/api/whoami-v2", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("連不上 Hugging Face：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return "", &Invalid{resp.StatusCode}
	}
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("Hugging Face 回應 HTTP %d", resp.StatusCode)
	}
	var who struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&who); err != nil {
		return "", err
	}
	return who.Name, nil
}
