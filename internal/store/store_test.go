package store_test

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/NoobBandi/TenkStack/internal/store"
	"github.com/NoobBandi/TenkStack/internal/store/storetest"

	_ "modernc.org/sqlite"
)

func TestMigrateIsRepeatable(t *testing.T) {
	db := storetest.New(t)
	if err := store.Migrate(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow("SELECT count(*) FROM schema_migrations").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("schema_migrations has %d rows, want 1", n)
	}
}

// The schema the SQLite console created, verbatim, so the import is tested
// against what is really on disk on an older install.
const sqliteSchema = `
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
	display_name TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL, salt TEXT NOT NULL,
	role TEXT NOT NULL DEFAULT 'member', created_at INTEGER NOT NULL);
CREATE TABLE api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
	prefix TEXT NOT NULL, key_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER);
CREATE TABLE conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,
	title TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', params TEXT NOT NULL DEFAULT '{}',
	pinned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT,
	conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
	seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
	reasoning TEXT, images TEXT, meta TEXT, created_at INTEGER NOT NULL);
CREATE TABLE settings (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE vision_descriptions (digest TEXT PRIMARY KEY, model TEXT NOT NULL,
	description TEXT NOT NULL, bytes INTEGER NOT NULL, created_at REAL NOT NULL);
INSERT INTO users VALUES (3, 'owner', 'Owner', 'h', 's', 'admin', 100);
INSERT INTO api_keys VALUES (7, 3, 'pi', 'sk-console-abc', 'kh', 101, NULL);
INSERT INTO conversations VALUES (12, 3, '台北', 'm', '{}', 1, 102, 103);
INSERT INTO conversations VALUES (15, NULL, 'second', 'm', '{}', 0, 104, 105);
INSERT INTO messages VALUES (40, 12, 0, 'user', 'hi' || char(0) || 'there', NULL, NULL, '{}', 102);
INSERT INTO messages VALUES (41, 12, 1, 'assistant', '你好', 'thinking', NULL, '{"model":"m"}', 103);
INSERT INTO settings VALUES ('log_lines', 5000);
INSERT INTO vision_descriptions VALUES ('d1', 'm', 'a cat', 1234, 106.5);
`

func writeSQLite(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "console.sqlite")
	src, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)")
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	if _, err := src.Exec(sqliteSchema); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestImportSQLite(t *testing.T) {
	ctx := context.Background()
	db := storetest.New(t)
	path := writeSQLite(t)

	counts, err := store.ImportSQLite(ctx, db, path)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]int{"users": 1, "api_keys": 1, "conversations": 2, "messages": 2, "settings": 1, "vision_descriptions": 1}
	for name, n := range want {
		if counts[name] != n {
			t.Errorf("%s: imported %d, want %d", name, counts[name], n)
		}
	}

	var pinned bool
	var title string
	if err := db.QueryRow("SELECT pinned, title FROM conversations WHERE id = 12").Scan(&pinned, &title); err != nil {
		t.Fatal(err)
	}
	if !pinned || title != "台北" {
		t.Errorf("conversation 12: pinned %v, title %q", pinned, title)
	}
	var content string
	if err := db.QueryRow("SELECT content FROM messages WHERE id = 40").Scan(&content); err != nil {
		t.Fatal(err)
	}
	if content != "hithere" {
		t.Errorf("message 40 content %q: the NUL should be gone", content)
	}
	var created float64
	if err := db.QueryRow("SELECT created_at FROM vision_descriptions WHERE digest = 'd1'").Scan(&created); err != nil || created != 106.5 {
		t.Errorf("vision created_at %v, %v", created, err)
	}

	// New rows continue after the copied ids instead of colliding with them.
	var id int64
	if err := db.QueryRow("INSERT INTO conversations (title, created_at, updated_at) VALUES ('new', 1, 1) RETURNING id").Scan(&id); err != nil {
		t.Fatal(err)
	}
	if id <= 15 {
		t.Errorf("new conversation got id %d, want > 15", id)
	}

	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("%s should have been set aside", path)
	}
	kept, _ := filepath.Glob(path + ".migrated-*")
	if len(kept) == 0 {
		t.Error("the SQLite file should be kept as .migrated-*")
	}
	again, err := store.ImportSQLite(ctx, db, path)
	if again != nil || err != nil {
		t.Errorf("second import: %v, %v; want nothing to do", again, err)
	}
}

func TestImportRefusesADatabaseWithData(t *testing.T) {
	ctx := context.Background()
	db := storetest.New(t)
	if _, err := db.Exec("INSERT INTO settings (name, value) VALUES ('x', 1)"); err != nil {
		t.Fatal(err)
	}
	path := writeSQLite(t)
	counts, err := store.ImportSQLite(ctx, db, path)
	if err == nil || counts != nil {
		t.Fatalf("import into a database with data: %v, %v; want a refusal", counts, err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("the refused file must stay where it is: %v", err)
	}
}

func TestText(t *testing.T) {
	if got := store.Text("a\x00b\xffc"); got != "ab�c" {
		t.Errorf("Text = %q", got)
	}
	if got := store.Text("中文"); got != "中文" || strings.ContainsRune(got, 0) {
		t.Errorf("Text changed valid text: %q", got)
	}
}
