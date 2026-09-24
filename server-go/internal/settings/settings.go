// Package settings holds the console's own knobs. A value is a setting when
// a reasonable owner would want it different and nothing else can derive it;
// facts about the machine are read from the machine instead. Defaults live
// in the spec, not the table, so clearing a row restores the behaviour.
package settings

import (
	"database/sql"
	"fmt"
	"log"
	"sync"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
)

type Spec struct {
	Name    string
	Label   string
	Note    string
	Default int64
	Minimum int64
	Maximum int64
	Unit    string
	Group   string
}

// Specs in display order. minimum and maximum are enforced here because the
// API is reachable without the browser.
var Specs = []Spec{
	{"agent_max_steps", "Agent 步數上限",
		"模型回答一個問題時，最多可以呼叫幾次工具（搜尋、讀網頁等）。用完後會請模型直接回答。",
		8, 1, 32, "步", "chat"},
	{"estimate_depth", "速度預估假設的對話長度",
		"模型目錄估算 tok/s 時，假設對話已經進行到多長。對話越長生成越慢，數字越大估得越保守。",
		4096, 256, 131072, "token", "chat"},
	{"vram_margin_gib", "顯存餘裕",
		"載入模型前估算要空出多少顯存時，在模型檔大小之外多留的空間。對話快取與運算緩衝都不算在檔案大小裡，太小可能載入到一半失敗。",
		4, 0, 32, "GiB", "vram"},
	{"comfyui_idle_gib", "ComfyUI 閒置門檻",
		"ComfyUI 佔用的顯存低於這個值時，視為沒在用，載入模型不會先停掉它。閒置的 ComfyUI 本來就會留著幾百 MB。",
		1, 0, 16, "GiB", "vram"},
	{"vision_cache", "舊圖片改用文字描述",
		"對話裡除了最新一張圖，較早的圖片改送模型自己寫過的描述。帶圖的對話會讓加速用的草稿模型失效，" +
			"本機實測生成從 34.7 掉到 12.6 tok/s（llama.cpp#27408）；開啟後速度回來，代價是模型看不到那些舊圖的原圖。",
		0, 0, 1, "", "chat"},
	{"log_lines", "日誌保留行數",
		"日誌頁最多能往回看幾行。",
		4000, 200, 50000, "行", "history"},
	{"gpu_history_hours", "顯示卡歷史時長",
		"顯示卡頁的圖表能往回看多久。每兩秒記一筆，拉長只會多用一點記憶體。",
		2, 1, 24, "小時", "history"},
}

var byName = func() map[string]Spec {
	m := map[string]Spec{}
	for _, s := range Specs {
		m[s.Name] = s
	}
	return m
}()

// ValidationError is a bad value from the caller, worth a 400.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

type Store struct {
	db *sql.DB

	mu    sync.Mutex
	cache map[string]int64 // nil until loaded
}

func New(db *sql.DB) *Store { return &Store{db: db} }

func (s *Store) Init() error {
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS settings (
		name  TEXT PRIMARY KEY,
		value INTEGER NOT NULL
	)`)
	return err
}

func (s *Store) load() map[string]int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cache != nil {
		return s.cache
	}
	cache := map[string]int64{}
	rows, err := s.db.Query("SELECT name, value FROM settings")
	if err != nil {
		log.Printf("could not read settings; using defaults: %v", err)
		s.cache = cache
		return cache
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		var value int64
		if rows.Scan(&name, &value) == nil {
			if _, known := byName[name]; known {
				cache[name] = value
			}
		}
	}
	s.cache = cache
	return cache
}

// Get is one setting or its default, read at the point of use so a change
// takes effect without a restart.
func (s *Store) Get(name string) int64 {
	if v, ok := s.load()[name]; ok {
		return v
	}
	return byName[name].Default
}

func (s *Store) All() map[string]int64 {
	out := map[string]int64{}
	for _, spec := range Specs {
		out[spec.Name] = s.Get(spec.Name)
	}
	return out
}

func (s *Store) Describe() []api.Setting {
	out := make([]api.Setting, 0, len(Specs))
	for _, spec := range Specs {
		out = append(out, api.Setting{
			Name: spec.Name, Value: s.Get(spec.Name), Label: spec.Label, Note: spec.Note,
			Default: spec.Default, Minimum: spec.Minimum, Maximum: spec.Maximum,
			Unit: spec.Unit, Group: spec.Group,
		})
	}
	return out
}

// Save writes the settings named and leaves the rest alone. A value equal
// to its default deletes the row, so the table holds only what somebody
// changed.
func (s *Store) Save(values map[string]any) (map[string]int64, error) {
	clean := map[string]int64{}
	for name, raw := range values {
		spec, ok := byName[name]
		if !ok {
			return nil, &ValidationError{fmt.Sprintf("沒有這個設定：%s", name)}
		}
		n, ok := toInt(raw)
		if !ok {
			return nil, &ValidationError{fmt.Sprintf("%s 需要一個整數", spec.Label)}
		}
		if n < spec.Minimum || n > spec.Maximum {
			return nil, &ValidationError{fmt.Sprintf("%s 要在 %d 到 %d 之間", spec.Label, spec.Minimum, spec.Maximum)}
		}
		clean[name] = n
	}
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	for name, n := range clean {
		if n == byName[name].Default {
			_, err = tx.Exec("DELETE FROM settings WHERE name = ?", name)
		} else {
			_, err = tx.Exec("INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", name, n)
		}
		if err != nil {
			tx.Rollback()
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.cache = nil
	s.mu.Unlock()
	log.Printf("settings saved: %v", clean)
	return s.All(), nil
}

// toInt accepts what Python's int() accepts from JSON: integers, whole
// floats truncated, and numeric strings.
func toInt(v any) (int64, bool) {
	switch x := v.(type) {
	case float64:
		return int64(x), true
	case string:
		var n int64
		_, err := fmt.Sscanf(x, "%d", &n)
		return n, err == nil
	case bool:
		if x {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}
