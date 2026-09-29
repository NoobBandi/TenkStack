package hftoken

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestStore(t *testing.T) {
	s := New(filepath.Join(t.TempDir(), "hf-token"))
	if s.Get() != "" {
		t.Fatal("a new store has a token")
	}
	if err := s.Set("  hf_abcdefghWXYZ \n"); err != nil {
		t.Fatal(err)
	}
	if s.Get() != "hf_abcdefghWXYZ" || Hint(s.Get()) != "hf_…WXYZ" {
		t.Errorf("got %q, hint %q", s.Get(), Hint(s.Get()))
	}
	if st, _ := os.Stat(s.Path); st.Mode().Perm() != 0o600 {
		t.Errorf("mode %v, want 0600", st.Mode().Perm())
	}
	if fresh := New(s.Path); fresh.Get() != "hf_abcdefghWXYZ" {
		t.Error("the token did not survive a restart")
	}
	s.Clear()
	if s.Get() != "" {
		t.Error("cleared but still set")
	}
}

func TestWhoAmI(t *testing.T) {
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer hf_good" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Write([]byte(`{"name":"tenk"}`))
	}))
	defer hub.Close()
	s := New(filepath.Join(t.TempDir(), "t"))
	s.Hub = hub.URL
	if name, err := s.WhoAmI(context.Background(), "hf_good"); err != nil || name != "tenk" {
		t.Errorf("%q %v", name, err)
	}
	var invalid *Invalid
	if _, err := s.WhoAmI(context.Background(), "hf_bad"); !errors.As(err, &invalid) {
		t.Errorf("a refused token: %v", err)
	}
}
