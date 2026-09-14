// Package api holds the wire types: every JSON body the frontend reads is
// defined here and nowhere else.
package api

type Error struct {
	Detail string `json:"detail"`
}

type OK struct {
	OK bool `json:"ok"`
}

// Identity is who is calling, as resolved by the auth middleware.
type Identity struct {
	UserID   int64  `json:"user_id"`
	Username string `json:"username"`
	Role     string `json:"role"`
	Via      string `json:"via"` // "session" or "api-key"
}

type Me struct {
	Identity    *Identity `json:"identity"`
	Enforcement bool      `json:"enforcement"`
}

type Version struct {
	Version string `json:"version"`
}

// LoginUser is what a successful password check returns.
type LoginUser struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Role        string `json:"role"`
}

type User struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Role        string `json:"role"`
	CreatedAt   int64  `json:"created_at"`
}

type UserRow struct {
	User
	KeyCount int64 `json:"key_count"`
}

type APIKey struct {
	ID         int64  `json:"id"`
	UserID     int64  `json:"user_id"`
	Name       string `json:"name"`
	Prefix     string `json:"prefix"`
	CreatedAt  int64  `json:"created_at"`
	LastUsedAt *int64 `json:"last_used_at"`
	Username   string `json:"username"`
}

// NewAPIKey carries the secret, which is returned once and never stored.
type NewAPIKey struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Prefix    string `json:"prefix"`
	CreatedAt int64  `json:"created_at"`
	Secret    string `json:"secret"`
}
