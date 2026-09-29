// Package users stores accounts and API keys. Hashes and key formats match the
// Python backend so one database serves both during the port.
package users

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"golang.org/x/crypto/scrypt"

	"github.com/NoobBandi/TenkStack/internal/api"
)

const (
	scryptN   = 1 << 14
	scryptR   = 8
	scryptP   = 1
	KeyPrefix = "sk-console-"
)

type Store struct {
	db *sql.DB
}

func New(db *sql.DB) *Store { return &Store{db: db} }

func (s *Store) Init() error {
	_, err := s.db.Exec(`
		CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT NOT NULL UNIQUE,
			display_name TEXT NOT NULL DEFAULT '',
			password_hash TEXT NOT NULL,
			salt TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'member',
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS api_keys (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			prefix TEXT NOT NULL,
			key_hash TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			last_used_at INTEGER
		);`)
	return err
}

func hashPassword(password string, salt []byte) (string, error) {
	key, err := scrypt.Key([]byte(password), salt, scryptN, scryptR, scryptP, 32)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(key), nil
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

func (s *Store) Create(username, password, displayName, role string) (api.User, error) {
	if displayName == "" {
		displayName = username
	}
	salt := randomBytes(16)
	hash, err := hashPassword(password, salt)
	if err != nil {
		return api.User{}, err
	}
	now := time.Now().Unix()
	res, err := s.db.Exec(
		"INSERT INTO users (username, display_name, password_hash, salt, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		username, displayName, hash, hex.EncodeToString(salt), role, now)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return api.User{}, errors.New("UNIQUE constraint failed: users.username")
		}
		return api.User{}, err
	}
	id, _ := res.LastInsertId()
	return api.User{ID: id, Username: username, DisplayName: displayName, Role: role, CreatedAt: now}, nil
}

// VerifyPassword returns nil, nil for a wrong password or unknown user.
func (s *Store) VerifyPassword(username, password string) (*api.LoginUser, error) {
	var u api.LoginUser
	var hash, saltHex string
	err := s.db.QueryRow(
		"SELECT id, username, display_name, role, password_hash, salt FROM users WHERE username = ?", username,
	).Scan(&u.ID, &u.Username, &u.DisplayName, &u.Role, &hash, &saltHex)
	if err == sql.ErrNoRows {
		// Same cost as a real check, so timing does not enumerate usernames.
		_, _ = hashPassword(password, randomBytes(16))
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	salt, err := hex.DecodeString(saltHex)
	if err != nil {
		return nil, err
	}
	got, err := hashPassword(password, salt)
	if err != nil {
		return nil, err
	}
	if subtle.ConstantTimeCompare([]byte(got), []byte(hash)) != 1 {
		return nil, nil
	}
	return &u, nil
}

func (s *Store) List() ([]api.UserRow, error) {
	rows, err := s.db.Query(`
		SELECT u.id, u.username, u.display_name, u.role, u.created_at,
		       (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id) AS key_count
		FROM users u ORDER BY u.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []api.UserRow{}
	for rows.Next() {
		var r api.UserRow
		if err := rows.Scan(&r.ID, &r.Username, &r.DisplayName, &r.Role, &r.CreatedAt, &r.KeyCount); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) Any() (bool, error) {
	var n int
	err := s.db.QueryRow("SELECT COUNT(*) FROM users").Scan(&n)
	return n > 0, err
}

func (s *Store) Delete(id int64) (bool, error) {
	return affected(s.db.Exec("DELETE FROM users WHERE id = ?", id))
}

func (s *Store) SetPassword(id int64, password string) (bool, error) {
	salt := randomBytes(16)
	hash, err := hashPassword(password, salt)
	if err != nil {
		return false, err
	}
	return affected(s.db.Exec("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?",
		hash, hex.EncodeToString(salt), id))
}

func (s *Store) CreateAPIKey(userID int64, name string) (api.NewAPIKey, error) {
	secret := KeyPrefix + base64.RawURLEncoding.EncodeToString(randomBytes(32))
	prefix := secret[:len(KeyPrefix)+6]
	sum := sha256.Sum256([]byte(secret))
	now := time.Now().Unix()
	res, err := s.db.Exec(
		"INSERT INTO api_keys (user_id, name, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)",
		userID, name, prefix, hex.EncodeToString(sum[:]), now)
	if err != nil {
		return api.NewAPIKey{}, err
	}
	id, _ := res.LastInsertId()
	return api.NewAPIKey{ID: id, Name: name, Prefix: prefix, CreatedAt: now, Secret: secret}, nil
}

func (s *Store) ListAPIKeys() ([]api.APIKey, error) {
	rows, err := s.db.Query(`
		SELECT k.id, k.user_id, k.name, k.prefix, k.created_at, k.last_used_at, u.username
		FROM api_keys k JOIN users u ON u.id = k.user_id ORDER BY k.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []api.APIKey{}
	for rows.Next() {
		var k api.APIKey
		if err := rows.Scan(&k.ID, &k.UserID, &k.Name, &k.Prefix, &k.CreatedAt, &k.LastUsedAt, &k.Username); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// Role is a user's role as it is now, and ok false for a user that no
// longer exists: a session outlives neither a deletion nor a demotion.
func (s *Store) Role(id int64) (role string, ok bool, err error) {
	err = s.db.QueryRow("SELECT role FROM users WHERE id = ?", id).Scan(&role)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	return role, err == nil, err
}

// APIKeyOwner is the user a key belongs to, and ok false for no such key.
func (s *Store) APIKeyOwner(id int64) (userID int64, ok bool, err error) {
	err = s.db.QueryRow("SELECT user_id FROM api_keys WHERE id = ?", id).Scan(&userID)
	if err == sql.ErrNoRows {
		return 0, false, nil
	}
	return userID, err == nil, err
}

func (s *Store) DeleteAPIKey(id int64) (bool, error) {
	return affected(s.db.Exec("DELETE FROM api_keys WHERE id = ?", id))
}

// VerifyAPIKey returns nil, nil for an unknown key.
func (s *Store) VerifyAPIKey(secret string) (*api.Identity, error) {
	sum := sha256.Sum256([]byte(secret))
	var keyID int64
	id := api.Identity{Via: "api-key"}
	err := s.db.QueryRow(`
		SELECT k.id, u.id, u.username, u.role FROM api_keys k
		JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?`, hex.EncodeToString(sum[:]),
	).Scan(&keyID, &id.UserID, &id.Username, &id.Role)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	_, err = s.db.Exec("UPDATE api_keys SET last_used_at = ? WHERE id = ?", time.Now().Unix(), keyID)
	return &id, err
}

func affected(res sql.Result, err error) (bool, error) {
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}
