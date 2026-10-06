package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// table is one SQLite table to copy, in foreign-key order. bools are columns
// SQLite kept as 0/1 that are BOOLEAN here; serial says the id is an identity
// column whose sequence has to move past the copied ids.
type table struct {
	name    string
	columns []string
	bools   map[string]bool
	serial  bool
}

var imported = []table{
	{name: "users", columns: []string{"id", "username", "display_name", "password_hash", "salt", "role", "created_at"}, serial: true},
	{name: "api_keys", columns: []string{"id", "user_id", "name", "prefix", "key_hash", "created_at", "last_used_at"}, serial: true},
	{name: "conversations", columns: []string{"id", "user_id", "title", "model", "params", "pinned", "created_at", "updated_at"},
		bools: map[string]bool{"pinned": true}, serial: true},
	{name: "messages", columns: []string{"id", "conversation_id", "seq", "role", "content", "reasoning", "images", "meta", "created_at"}, serial: true},
	{name: "settings", columns: []string{"name", "value"}},
	{name: "vision_descriptions", columns: []string{"digest", "model", "description", "bytes", "created_at"}},
}

// ImportSQLite copies an older console's SQLite database in, once: only into
// an empty database, all tables in one transaction, each table's row count
// checked before the commit. The file is renamed afterwards, never deleted,
// so nothing is lost if something turns out to be missing. It reports how
// many rows each table brought; nil when there was nothing to do.
func ImportSQLite(ctx context.Context, db *sql.DB, path string) (map[string]int, error) {
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	var existing int
	if err := db.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM conversations)
		+ (SELECT count(*) FROM settings)`).Scan(&existing); err != nil {
		return nil, err
	}
	if existing > 0 {
		return nil, fmt.Errorf("%s is still there but the database already has data; not importing it again", path)
	}

	src, err := sql.Open("sqlite", fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)", path))
	if err != nil {
		return nil, err
	}
	defer src.Close()
	// Folds the WAL into the main file, so the copy and the renamed file
	// both hold every committed row.
	if _, err := src.ExecContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		return nil, err
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	counts := map[string]int{}
	for _, t := range imported {
		var present int
		if err := src.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?", t.name).
			Scan(&present); err != nil {
			return nil, err
		}
		if present == 0 { // an install from before the table existed
			continue
		}
		n, err := copyTable(ctx, src, tx, t)
		if err != nil {
			return nil, fmt.Errorf("import %s: %w", t.name, err)
		}
		var got int
		if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM "+t.name).Scan(&got); err != nil {
			return nil, err
		}
		if got != n {
			return nil, fmt.Errorf("import %s: read %d rows, the database holds %d", t.name, n, got)
		}
		if t.serial {
			if _, err := tx.ExecContext(ctx, fmt.Sprintf(
				"SELECT setval(pg_get_serial_sequence('%[1]s', 'id'), COALESCE((SELECT max(id) FROM %[1]s), 0) + 1, false)",
				t.name)); err != nil {
				return nil, err
			}
		}
		counts[t.name] = n
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	src.Close()

	suffix := ".migrated-" + time.Now().Format("20060102-150405")
	for _, p := range []string{path, path + "-wal", path + "-shm"} {
		if _, err := os.Stat(p); err == nil {
			if err := os.Rename(p, p+suffix); err != nil {
				return counts, fmt.Errorf("imported, but could not set %s aside: %w", p, err)
			}
		}
	}
	return counts, nil
}

func copyTable(ctx context.Context, src *sql.DB, tx *sql.Tx, t table) (int, error) {
	rows, err := src.QueryContext(ctx, "SELECT "+strings.Join(t.columns, ", ")+" FROM "+t.name)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	marks := make([]string, len(t.columns))
	for i := range marks {
		marks[i] = fmt.Sprintf("$%d", i+1)
	}
	insert := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", t.name, strings.Join(t.columns, ", "), strings.Join(marks, ", "))
	n := 0
	for rows.Next() {
		values := make([]any, len(t.columns))
		ptrs := make([]any, len(t.columns))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return n, err
		}
		for i, col := range t.columns {
			switch v := values[i].(type) {
			case string:
				values[i] = Text(v)
			case []byte:
				values[i] = Text(string(v))
			case int64:
				if t.bools[col] {
					values[i] = v != 0
				}
			}
		}
		if _, err := tx.ExecContext(ctx, insert, values...); err != nil {
			return n, err
		}
		n++
	}
	return n, rows.Err()
}
