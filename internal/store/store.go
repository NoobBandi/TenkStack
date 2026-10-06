// Package store opens the console's PostgreSQL database, brings its schema up
// to date and, once, moves an older install's SQLite data into it.
package store

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// Open connects and waits for the server to answer: on a fresh install the
// database container is still pulling its image or initialising its data
// directory when the console starts, which is a wait, not a failure.
func Open(ctx context.Context, dsn string, wait time.Duration) (*sql.DB, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(wait)
	for attempt := 0; ; attempt++ {
		pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err = db.PingContext(pingCtx)
		cancel()
		if err == nil {
			return db, nil
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			db.Close()
			return nil, fmt.Errorf("database not reachable after %s: %w", wait, err)
		}
		if attempt%6 == 0 {
			log.Printf("waiting for the database: %v", err)
		}
		time.Sleep(2 * time.Second)
	}
}

// Text makes a string storable: PostgreSQL refuses NUL bytes and invalid
// UTF-8 in text columns, which SQLite took, and model output can carry both.
func Text(s string) string {
	return strings.ReplaceAll(strings.ToValidUTF8(s, "�"), "\x00", "")
}
