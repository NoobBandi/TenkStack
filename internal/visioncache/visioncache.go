// Package visioncache sends an image to the model once and refers to it by
// the model's own description afterwards. A picture in the request drops a
// recurrent drafter from 67% acceptance to 1% and never recovers while the
// image is still being sent; the newest image is always left alone.
package visioncache

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const prompt = "請詳細描述這張圖，讓沒看過它的人能據此回答關於它的問題。" +
	"包含：主體與內容、版面配置與相對位置、顏色（可能的話給色碼）、" +
	"圖中所有可辨識的文字、以及風格或用途。只描述看得到的東西。"

// Long enough to be useful, short enough to stay cheaper than the image.
const maxTokens = 400

// The --spec-type values that carry a recurrent draft cache. draft-mtp and
// the ngram family keep no per-position draft state an image can break.
var fragileDrafters = map[string]bool{"draft-dflash": true, "draft-eagle3": true, "draft-dspark": true, "draft-simple": true}

// Specs is what the cache needs from the config: a model's extra flags.
type Specs interface {
	ExtraOf(modelID string) (extra string, ok bool)
}

type Cache struct {
	db         *sql.DB
	specs      Specs
	configPath string
	llamaSwap  string // base URL

	mu       sync.Mutex
	pending  map[string]bool
	drafters map[string]bool
	stamp    time.Time
}

func New(db *sql.DB, specs Specs, configPath, llamaSwapBase string) *Cache {
	return &Cache{db: db, specs: specs, configPath: configPath, llamaSwap: llamaSwapBase,
		pending: map[string]bool{}, drafters: map[string]bool{}}
}

func (c *Cache) Init() error {
	_, err := c.db.Exec(`CREATE TABLE IF NOT EXISTS vision_descriptions (
		digest      TEXT PRIMARY KEY,
		model       TEXT NOT NULL,
		description TEXT NOT NULL,
		bytes       INTEGER NOT NULL,
		created_at  REAL NOT NULL
	)`)
	return err
}

// DigestOf is a stable name for one image: over the payload, so the same
// picture with a different mime prefix is the same picture.
func DigestOf(dataURL string) string {
	payload := dataURL
	if _, after, ok := strings.Cut(dataURL, ","); ok {
		payload = after
	}
	sum := sha256.Sum256([]byte(payload))
	return hex.EncodeToString(sum[:])
}

func (c *Cache) lookup(digest string) (string, bool) {
	var text string
	if err := c.db.QueryRow("SELECT description FROM vision_descriptions WHERE digest = ?", digest).Scan(&text); err != nil {
		return "", false
	}
	return text, true
}

func (c *Cache) store(digest, model, description string, size int) {
	c.db.Exec("INSERT OR REPLACE INTO vision_descriptions (digest, model, description, bytes, created_at) VALUES (?, ?, ?, ?, ?)",
		digest, model, description, size, float64(time.Now().UnixNano())/1e9)
}

// HasFragileDrafter says whether a launch line names a drafter images break.
func HasFragileDrafter(cmd string) bool {
	tokens := strings.Fields(cmd)
	for i, tok := range tokens {
		var kinds []string
		switch {
		case tok == "--spec-type" && i+1 < len(tokens):
			kinds = strings.Split(tokens[i+1], ",")
		case strings.HasPrefix(tok, "--spec-type="):
			kinds = strings.Split(strings.TrimPrefix(tok, "--spec-type="), ",")
		default:
			continue
		}
		for _, k := range kinds {
			if fragileDrafters[k] {
				return true
			}
		}
	}
	return false
}

// usesDraftModel is cached on the config's mtime, since changing a model's
// drafter is exactly the edit that makes a cached answer wrong.
func (c *Cache) usesDraftModel(modelID string) bool {
	var stamp time.Time
	if st, err := os.Stat(c.configPath); err == nil {
		stamp = st.ModTime()
	}
	c.mu.Lock()
	if stamp.Equal(c.stamp) {
		if found, ok := c.drafters[modelID]; ok {
			c.mu.Unlock()
			return found
		}
	} else {
		c.drafters = map[string]bool{}
		c.stamp = stamp
	}
	c.mu.Unlock()
	found := false
	if extra, ok := c.specs.ExtraOf(modelID); ok {
		found = HasFragileDrafter(strings.Join(strings.Split(extra, "\n"), " "))
	}
	c.mu.Lock()
	c.drafters[modelID] = found
	c.mu.Unlock()
	return found
}

type imagePart struct {
	index int
	url   string
}

func imagesIn(message map[string]any) []imagePart {
	content, ok := message["content"].([]any)
	if !ok {
		return nil
	}
	var found []imagePart
	for i, part := range content {
		p, _ := part.(map[string]any)
		if p == nil || p["type"] != "image_url" {
			continue
		}
		iu, _ := p["image_url"].(map[string]any)
		if url, _ := iu["url"].(string); strings.HasPrefix(url, "data:") {
			found = append(found, imagePart{i, url})
		}
	}
	return found
}

// describe asks the model to describe one image, through llama-swap so it
// lands on the model already loaded.
func (c *Cache) describe(model, dataURL string) string {
	body, _ := json.Marshal(map[string]any{
		"model": model,
		"messages": []map[string]any{{"role": "user", "content": []map[string]any{
			{"type": "text", "text": prompt},
			{"type": "image_url", "image_url": map[string]any{"url": dataURL}},
		}}},
		"max_tokens": maxTokens, "temperature": 0,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, c.llamaSwap+"/v1/chat/completions", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		log.Printf("could not describe an image for %s: %v", model, err)
		return ""
	}
	defer resp.Body.Close()
	var out struct {
		Choices []struct {
			Message struct {
				Content          string `json:"content"`
				ReasoningContent string `json:"reasoning_content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if resp.StatusCode >= 400 || json.NewDecoder(resp.Body).Decode(&out) != nil || len(out.Choices) == 0 {
		log.Printf("could not describe an image for %s: HTTP %d", model, resp.StatusCode)
		return ""
	}
	// A thinking model may put everything in reasoning_content when the
	// answer runs past the budget; either is better than nothing.
	text := strings.TrimSpace(out.Choices[0].Message.Content)
	if text == "" {
		text = strings.TrimSpace(out.Choices[0].Message.ReasoningContent)
	}
	return text
}

// remember describes this image in the background, if it is new.
func (c *Cache) remember(model, dataURL string) {
	key := DigestOf(dataURL)
	c.mu.Lock()
	if c.pending[key] {
		c.mu.Unlock()
		return
	}
	c.mu.Unlock()
	if _, ok := c.lookup(key); ok {
		return
	}
	c.mu.Lock()
	c.pending[key] = true
	c.mu.Unlock()
	go func() {
		defer func() {
			c.mu.Lock()
			delete(c.pending, key)
			c.mu.Unlock()
		}()
		if text := c.describe(model, dataURL); text != "" {
			c.store(key, model, text, len(dataURL))
			log.Printf("described image %s for %s (%d chars)", key[:12], model, len(text))
		}
	}()
}

// Rewrite replaces already-described images with their descriptions and
// returns how many. The boundary is the turn being answered: an image in
// the final user message stays; one in an earlier, answered turn is
// replaced, since the reply about it is right there in the transcript.
func (c *Cache) Rewrite(body map[string]any) (map[string]any, int) {
	messages, ok := body["messages"].([]any)
	if !ok || len(messages) < 2 {
		return body, 0
	}
	model, _ := body["model"].(string)
	if !c.usesDraftModel(model) {
		return body, 0
	}
	boundary := len(messages)
	for i := len(messages) - 1; i >= 0; i-- {
		if m, _ := messages[i].(map[string]any); m != nil && m["role"] == "user" {
			boundary = i
			break
		}
	}
	if boundary < len(messages) {
		if m, _ := messages[boundary].(map[string]any); m != nil {
			for _, img := range imagesIn(m) {
				c.remember(model, img.url)
			}
		}
	}
	replaced := 0
	out := make([]any, len(messages))
	copy(out, messages)
	for i := 0; i < boundary; i++ {
		m, _ := out[i].(map[string]any)
		if m == nil {
			continue
		}
		images := imagesIn(m)
		if len(images) == 0 {
			continue
		}
		answered := false
		for j := i + 1; j <= boundary && j < len(messages); j++ {
			if later, _ := messages[j].(map[string]any); later != nil && later["role"] == "assistant" {
				answered = true
			}
		}
		if !answered {
			continue
		}
		content, _ := m["content"].([]any)
		newContent := make([]any, len(content))
		copy(newContent, content)
		for _, img := range images {
			text := "［圖片已省略——模型稍早看過它，它的說明在下一則訊息］"
			if desc, ok := c.lookup(DigestOf(img.url)); ok {
				text = "［這張圖模型稍早看過，以下是它的描述］\n" + desc
			}
			newContent[img.index] = map[string]any{"type": "text", "text": text}
			replaced++
		}
		newMessage := map[string]any{}
		for k, v := range m {
			newMessage[k] = v
		}
		newMessage["content"] = newContent
		out[i] = newMessage
	}
	if replaced == 0 {
		return body, 0
	}
	newBody := map[string]any{}
	for k, v := range body {
		newBody[k] = v
	}
	newBody["messages"] = out
	return newBody, replaced
}
