// Package storetest gives a test its own empty, migrated database: a schema
// of its own in the server CONSOLE_TEST_DATABASE_URL names, dropped when the
// test ends, so tests run in parallel against one server without seeing each
// other. scripts/test.sh starts a throwaway server and sets the variable.
package storetest

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/NoobBandi/TenkStack/internal/store"
)

// DSN is the test server and a fresh schema in it, which the caller owns.
func DSN(t testing.TB) string {
	t.Helper()
	base := os.Getenv("CONSOLE_TEST_DATABASE_URL")
	if base == "" {
		// A failure, not a skip: a skipped store test reads as a passing one.
		t.Fatal("CONSOLE_TEST_DATABASE_URL is not set; run scripts/test.sh, which starts a throwaway PostgreSQL, or point it at one")
	}
	admin, err := sql.Open("pgx", base)
	if err != nil {
		t.Fatal(err)
	}
	b := make([]byte, 8)
	rand.Read(b)
	schema := "t_" + hex.EncodeToString(b)
	if _, err := admin.Exec("CREATE SCHEMA " + schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		admin.Exec("DROP SCHEMA " + schema + " CASCADE")
		admin.Close()
	})
	return withSearchPath(base, schema)
}

// New is DSN, opened and migrated.
func New(t testing.TB) *sql.DB {
	t.Helper()
	db, err := sql.Open("pgx", DSN(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() }) // registered after DSN's, so it runs before the drop
	if err := store.Migrate(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	return db
}

func withSearchPath(dsn, schema string) string {
	if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
		u, err := url.Parse(dsn)
		if err == nil {
			q := u.Query()
			q.Set("search_path", schema)
			u.RawQuery = q.Encode()
			return u.String()
		}
	}
	return dsn + " search_path=" + schema
}
