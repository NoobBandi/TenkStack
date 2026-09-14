package api

type ChatRow struct {
	ID           int64  `json:"id"`
	Title        string `json:"title"`
	Model        string `json:"model"`
	Pinned       int64  `json:"pinned"`
	CreatedAt    int64  `json:"created_at"`
	UpdatedAt    int64  `json:"updated_at"`
	MessageCount int64  `json:"message_count"`
}

type Conversation struct {
	ID        int64            `json:"id"`
	UserID    *int64           `json:"user_id"`
	Title     string           `json:"title"`
	Model     string           `json:"model"`
	Params    map[string]any   `json:"params"`
	Pinned    int64            `json:"pinned"`
	CreatedAt int64            `json:"created_at"`
	UpdatedAt int64            `json:"updated_at"`
	Messages  []map[string]any `json:"messages"`
}

type ChatSaved struct {
	ID int64 `json:"id"`
}

type SearchHit struct {
	Title     string `json:"title"`
	URL       any    `json:"url"`
	Snippet   string `json:"snippet"`
	Engines   []any  `json:"engines"`
	Published any    `json:"published"`
}

type SearchResponse struct {
	Query   any         `json:"query"`
	Results []SearchHit `json:"results"`
	Answers []any       `json:"answers"`
}

type Available struct {
	Available bool `json:"available"`
}
