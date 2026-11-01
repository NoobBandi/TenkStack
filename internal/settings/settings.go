// Package settings holds the console's own knobs. A value is a setting when
// a reasonable owner would want it different and nothing else can derive it;
// facts about the machine are read from the machine instead. Defaults live
// in Specs, not the table, so clearing a row restores the behaviour.
package settings

import (
	"database/sql"
	"fmt"
	"log"
	"sync"

	"github.com/NoobBandi/TenkStack/internal/api"
)

type Spec struct {
	Name  string
	Label string
	// Note is one line under the label; Detail, when the setting needs more,
	// is behind an info mark beside it.
	Note    string
	Detail  string
	Default int64
	Minimum int64
	Maximum int64
	Unit    string
	Group   string
}

// Specs in display order. minimum and maximum are enforced here because the
// API is reachable without the browser.
var Specs = []Spec{
	{Name: "agent_max_steps", Label: "Agent 步數上限",
		Note:    "回答一個問題最多能呼叫幾次工具（搜尋、讀網頁）",
		Detail:  "用完後會請模型直接回答。",
		Default: 8, Minimum: 1, Maximum: 32, Unit: "步", Group: "chat"},
	{Name: "sandbox_timeout_s", Label: "Python 執行時間上限",
		Note:    "Agent 每次執行 Python 最多能跑多久，超過就中斷",
		Detail:  "中斷後變數還在，模型可以接著做；中斷不了的程式會連同環境一起重設。",
		Default: 120, Minimum: 10, Maximum: 1800, Unit: "秒", Group: "chat"},
	{Name: "sandbox_memory_gib", Label: "Python 沙箱記憶體",
		Note:    "每個對話的沙箱最多能用多少記憶體，包含它存的檔案",
		Detail:  "用完時程式會被系統終止，環境重設。改了之後新開的沙箱才會套用。",
		Default: 4, Minimum: 1, Maximum: 64, Unit: "GiB", Group: "chat"},
	{Name: "estimate_depth", Label: "速度預估的對話長度",
		Note:    "模型目錄估算 tok/s 時，假設對話已經有多長",
		Detail:  "對話越長生成越慢，數字越大估得越保守。",
		Default: 4096, Minimum: 256, Maximum: 131072, Unit: "token", Group: "catalog"},
	{Name: "vram_margin_gib", Label: "顯存餘裕",
		Note:    "載入模型前，在模型檔大小之外多留的顯存",
		Detail:  "對話快取與運算緩衝都不算在檔案大小裡，留太少可能載入到一半失敗。",
		Default: 4, Minimum: 0, Maximum: 32, Unit: "GiB", Group: "vram"},
	{Name: "comfyui_idle_gib", Label: "ComfyUI 閒置門檻",
		Note:    "ComfyUI 用量低於這個值就算閒置，載入模型時不會停掉它",
		Detail:  "閒置的 ComfyUI 本來就會留著幾百 MB。",
		Default: 1, Minimum: 0, Maximum: 16, Unit: "GiB", Group: "vram"},
	{Name: "comfyui_idle_free_s", Label: "ComfyUI 閒置自動釋放",
		Note:    "ComfyUI 沒有工作超過這麼久，就卸掉它載入的模型，把顯示卡讓出來；0 表示不自動釋放",
		Detail:  "ComfyUI 本身不會釋放：算完圖，模型就一直佔著顯示卡，等下一張圖用。釋放後下一張圖要重新載入模型，大模型會慢幾十秒。",
		Default: 60, Minimum: 0, Maximum: 3600, Unit: "秒", Group: "vram"},
	{Name: "vision_cache", Label: "舊圖片改用文字描述",
		Note: "較早的圖片改送模型寫過的描述，加速才不會失效",
		Detail: "帶圖的對話會讓加速用的草稿模型失效，本機實測生成從 34.7 掉到 12.6 tok/s（llama.cpp#27408）。" +
			"開啟後速度回來，代價是模型看不到那些舊圖的原圖；最新的一張照常送出。",
		Default: 0, Minimum: 0, Maximum: 1, Group: "chat"},
	{Name: "log_lines", Label: "日誌保留行數",
		Note:    "日誌頁最多能往回看幾行",
		Default: 4000, Minimum: 200, Maximum: 50000, Unit: "行", Group: "history"},
	{Name: "gpu_history_hours", Label: "顯示卡歷史時長",
		Note:    "顯示卡頁的圖表能往回看多久",
		Detail:  "每兩秒記一筆，拉長只會多用一點記憶體。",
		Default: 2, Minimum: 1, Maximum: 24, Unit: "小時", Group: "history"},
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
			Unit: spec.Unit, Group: spec.Group, Detail: spec.Detail,
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
			_, err = tx.Exec("DELETE FROM settings WHERE name = $1", name)
		} else {
			_, err = tx.Exec("INSERT INTO settings (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = excluded.value", name, n)
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
