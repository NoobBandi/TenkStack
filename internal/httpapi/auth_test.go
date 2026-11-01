package httpapi

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestLoginFailuresBlockThenExpire(t *testing.T) {
	f := &failures{window: time.Minute, limit: 3, seen: map[string][]time.Time{}}
	now := time.Now()
	for range 3 {
		if f.blocked("a", now) {
			t.Fatal("blocked before the limit")
		}
		f.add("a", now)
	}
	if !f.blocked("a", now) {
		t.Fatal("not blocked at the limit")
	}
	if f.blocked("b", now) {
		t.Fatal("another address is blocked too")
	}
	if f.blocked("a", now.Add(2*time.Minute)) {
		t.Fatal("still blocked after the window")
	}
	f.add("a", now)
	f.clear("a")
	if len(f.seen) != 0 {
		t.Fatalf("clear left %v", f.seen)
	}
}

// Caddy appends the address it saw, so the last entry is the one to trust.
func TestClientAddressTakesCaddysEntry(t *testing.T) {
	r := httptest.NewRequest("POST", "/api/auth/login", nil)
	r.Header.Set("X-Forwarded-For", "1.2.3.4, 192.0.2.7")
	if got := clientAddress(r); got != "192.0.2.7" {
		t.Fatalf("got %q", got)
	}
	r.Header.Del("X-Forwarded-For")
	r.RemoteAddr = "127.0.0.1:5555"
	if got := clientAddress(r); got != "127.0.0.1" {
		t.Fatalf("got %q", got)
	}
}
