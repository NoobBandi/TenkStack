// Package chats is conversation history: two tables, no branching, titles
// taken from the first user message rather than generated.
package chats

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/NoobBandi/TenkStack/internal/api"
	"github.com/NoobBandi/TenkStack/internal/store"
)

const titleLength = 48

// Images stores attachments out of the row and maps them back to URLs.
type Images interface {
	ToRefs(images []string) []string
	ToURLs(images []string) []string
}

type Store struct {
	db     *sql.DB
	images Images
}

func New(db *sql.DB, images Images) *Store { return &Store{db: db, images: images} }

func titleFrom(messages []map[string]any) string {
	for _, m := range messages {
		if m["role"] != "user" {
			continue
		}
		text, _ := m["content"].(string)
		text = strings.ReplaceAll(strings.TrimSpace(text), "\n", " ")
		if text == "" {
			return "新對話"
		}
		if utf8.RuneCountInString(text) > titleLength {
			return string([]rune(text)[:titleLength]) + "…"
		}
		return text
	}
	return "新對話"
}

// pinned is BOOLEAN in the table and 0/1 in the API, as the SQLite store gave it.
const rowColumns = `c.id, c.title, c.model, c.pinned::int, c.created_at, c.updated_at,
	(SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count`

func scanRows(rows *sql.Rows) ([]api.ChatRow, error) {
	defer rows.Close()
	out := []api.ChatRow{}
	for rows.Next() {
		var r api.ChatRow
		if err := rows.Scan(&r.ID, &r.Title, &r.Model, &r.Pinned, &r.CreatedAt, &r.UpdatedAt, &r.MessageCount); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) List(userID *int64, limit int) ([]api.ChatRow, error) {
	query := "SELECT " + rowColumns + " FROM conversations c"
	args := []any{}
	if userID != nil {
		args = append(args, *userID)
		query += fmt.Sprintf(" WHERE c.user_id = $%d", len(args))
	}
	args = append(args, limit)
	query += fmt.Sprintf(" ORDER BY c.pinned DESC, c.updated_at DESC LIMIT $%d", len(args))
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	return scanRows(rows)
}

// Search matches titles and bodies, so a conversation can be found by what
// was said in it. ILIKE, because SQLite's LIKE ignored case and searches
// found what they found then; % and _ in the query stay wildcards, as before.
func (s *Store) Search(q string, userID *int64, limit int) ([]api.ChatRow, error) {
	like := "%" + store.Text(q) + "%"
	query := "SELECT " + rowColumns + ` FROM conversations c
		WHERE (c.title ILIKE $1 OR EXISTS (
			SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content ILIKE $1))`
	args := []any{like}
	if userID != nil {
		args = append(args, *userID)
		query += fmt.Sprintf(" AND c.user_id = $%d", len(args))
	}
	args = append(args, limit)
	query += fmt.Sprintf(" ORDER BY c.pinned DESC, c.updated_at DESC LIMIT $%d", len(args))
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	return scanRows(rows)
}

// owned narrows a query on one conversation to the caller's own. A
// conversation is private to the account that made it, so someone else's
// answers as if it did not exist. userID is nil only while there are no
// accounts, the same state in which authentication is off.
func owned(query string, args []any, userID *int64) (string, []any) {
	if userID == nil {
		return query, args
	}
	args = append(args, *userID)
	return query + fmt.Sprintf(" AND user_id = $%d", len(args)), args
}

func (s *Store) Get(id int64, userID *int64) (*api.Conversation, error) {
	var c api.Conversation
	var params string
	query, args := owned("SELECT id, user_id, title, model, params, pinned::int, created_at, updated_at FROM conversations WHERE id = $1", []any{id}, userID)
	err := s.db.QueryRow(query, args...).
		Scan(&c.ID, &c.UserID, &c.Title, &c.Model, &params, &c.Pinned, &c.CreatedAt, &c.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	c.Params = map[string]any{}
	if params != "" {
		if json.Unmarshal([]byte(params), &c.Params) != nil || c.Params == nil {
			c.Params = map[string]any{}
		}
	}
	rows, err := s.db.Query("SELECT role, content, reasoning, images, meta FROM messages WHERE conversation_id = $1 ORDER BY seq", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	c.Messages = []map[string]any{}
	for rows.Next() {
		var role, content string
		var reasoning, images, meta sql.NullString
		if err := rows.Scan(&role, &content, &reasoning, &images, &meta); err != nil {
			return nil, err
		}
		message := map[string]any{"role": role, "content": content}
		if reasoning.Valid && reasoning.String != "" {
			message["reasoning"] = reasoning.String
		}
		if images.Valid && images.String != "" {
			var list []any
			if json.Unmarshal([]byte(images.String), &list) == nil {
				strs := make([]string, 0, len(list))
				for _, item := range list {
					if s, ok := item.(string); ok {
						strs = append(strs, s)
					} else {
						b, _ := json.Marshal(item)
						strs = append(strs, string(b))
					}
				}
				message["images"] = s.images.ToURLs(strs)
			}
		}
		if meta.Valid && meta.String != "" {
			var extra map[string]any
			if json.Unmarshal([]byte(meta.String), &extra) == nil {
				for k, v := range extra {
					message[k] = v
				}
			}
		}
		c.Messages = append(c.Messages, message)
	}
	return &c, rows.Err()
}

// metaKeys travel with a message because a conversation that used the
// sandbox is not reloadable without its tool calls, and model is
// per-message since a thread can be continued by another model.
var metaKeys = []string{"usage", "timings", "finish_reason", "ttft_ms", "thinking_ms", "decode_ms", "model", "tool_calls", "tool_call_id", "run"}

// ErrNoConversation is a save against an id that does not exist.
type ErrNoConversation struct{ ID int64 }

func (e *ErrNoConversation) Error() string { return "no such conversation" }

// Save creates or replaces a conversation's messages; the whole list is
// written each time, since regeneration and editing both rewrite the tail.
func (s *Store) Save(id *int64, messages []map[string]any, model string, params map[string]any, userID *int64, title *string) (int64, error) {
	now := time.Now().Unix()
	if params == nil {
		params = map[string]any{}
	}
	paramsJSON, _ := jsonNoEscape(params)

	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	var conversationID int64
	if id == nil {
		t := titleFrom(messages)
		if title != nil && *title != "" {
			t = *title
		}
		if err := tx.QueryRow("INSERT INTO conversations (user_id, title, model, params, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
			userID, store.Text(t), model, store.Text(paramsJSON), now, now).Scan(&conversationID); err != nil {
			return 0, err
		}
	} else {
		conversationID = *id
		var existing string
		query, args := owned("SELECT title FROM conversations WHERE id = $1", []any{conversationID}, userID)
		if err := tx.QueryRow(query+" FOR UPDATE", args...).Scan(&existing); err == sql.ErrNoRows {
			return 0, &ErrNoConversation{conversationID}
		} else if err != nil {
			return 0, err
		}
		// An empty or default title is filled once real content arrives; one
		// the user set is never overwritten.
		t := existing
		if title != nil && *title != "" {
			t = *title
		} else if t == "" {
			t = titleFrom(messages)
		}
		if _, err := tx.Exec("UPDATE conversations SET title = $1, model = $2, params = $3, updated_at = $4 WHERE id = $5",
			store.Text(t), model, store.Text(paramsJSON), now, conversationID); err != nil {
			return 0, err
		}
		if _, err := tx.Exec("DELETE FROM messages WHERE conversation_id = $1", conversationID); err != nil {
			return 0, err
		}
	}

	for seq, m := range messages {
		role, _ := m["role"].(string)
		if role == "" {
			role = "user"
		}
		content := ""
		switch c := m["content"].(type) {
		case string:
			content = c
		case nil:
		default:
			b, _ := json.Marshal(c)
			content = string(b)
		}
		var reasoning any
		if r, _ := m["reasoning"].(string); r != "" {
			reasoning = store.Text(r)
		}
		// Written to disk first and stored as a reference: a file with no row
		// is collected by the sweep, a row with no file is a broken image.
		var images any
		if list, ok := m["images"].([]any); ok && len(list) > 0 {
			strs := make([]string, 0, len(list))
			for _, item := range list {
				if s, ok := item.(string); ok {
					strs = append(strs, s)
				}
			}
			b, _ := jsonNoEscape(s.images.ToRefs(strs))
			images = b
		}
		meta := map[string]any{}
		for _, k := range metaKeys {
			if v, ok := m[k]; ok {
				meta[k] = v
			}
		}
		metaJSON, _ := jsonNoEscape(meta)
		if _, err := tx.Exec("INSERT INTO messages (conversation_id, seq, role, content, reasoning, images, meta, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
			conversationID, seq, role, store.Text(content), reasoning, images, store.Text(metaJSON), now); err != nil {
			return 0, err
		}
	}
	return conversationID, tx.Commit()
}

func jsonNoEscape(v any) (string, error) {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "", err
	}
	return strings.TrimSuffix(b.String(), "\n"), nil
}

func (s *Store) Update(id int64, userID *int64, title *string, pinned *bool) (bool, error) {
	var sets []string
	var args []any
	if title != nil {
		args = append(args, store.Text(*title))
		sets = append(sets, fmt.Sprintf("title = $%d", len(args)))
	}
	if pinned != nil {
		args = append(args, *pinned)
		sets = append(sets, fmt.Sprintf("pinned = $%d", len(args)))
	}
	if len(sets) == 0 {
		return false, nil
	}
	args = append(args, id)
	query, args := owned(fmt.Sprintf("UPDATE conversations SET %s WHERE id = $%d", strings.Join(sets, ", "), len(args)), args, userID)
	res, err := s.db.Exec(query, args...)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *Store) Delete(id int64, userID *int64) (bool, error) {
	query, args := owned("DELETE FROM conversations WHERE id = $1", []any{id}, userID)
	res, err := s.db.Exec(query, args...)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
