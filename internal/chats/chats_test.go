package chats

import (
	"testing"

	"github.com/NoobBandi/TenkStack/internal/store/storetest"
)

type refs struct{}

func (refs) ToRefs(images []string) []string { return images }
func (refs) ToURLs(images []string) []string { return images }

func TestSaveGetSearch(t *testing.T) {
	s := New(storetest.New(t), refs{})
	owner := int64(1)
	id, err := s.Save(nil, []map[string]any{
		{"role": "user", "content": "Hello 台北\x00"},
		{"role": "assistant", "content": "ok", "reasoning": "r", "model": "m"},
	}, "m", map[string]any{"temperature": 0.7}, &owner, nil)
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.Get(id)
	if err != nil || c == nil {
		t.Fatalf("Get: %v, %v", c, err)
	}
	if c.Title != "Hello 台北" || len(c.Messages) != 2 || c.Messages[1]["reasoning"] != "r" || c.Messages[1]["model"] != "m" {
		t.Errorf("round trip: %+v", c)
	}

	// Case-insensitive, as SQLite's LIKE was.
	for _, q := range []string{"hello", "HELLO", "台北"} {
		rows, err := s.Search(q, &owner, 10)
		if err != nil || len(rows) != 1 {
			t.Errorf("Search(%q) = %v, %v", q, rows, err)
		}
	}
	other := int64(2)
	if rows, _ := s.Search("hello", &other, 10); len(rows) != 0 {
		t.Errorf("another user's search found %v", rows)
	}

	pin := true
	if ok, err := s.Update(id, nil, &pin); !ok || err != nil {
		t.Fatalf("Update: %v, %v", ok, err)
	}
	list, err := s.List(&owner, 10)
	if err != nil || len(list) != 1 || list[0].Pinned != 1 || list[0].MessageCount != 2 {
		t.Errorf("List = %+v, %v", list, err)
	}

	// Saving again replaces the messages and keeps the title.
	if _, err := s.Save(&id, []map[string]any{{"role": "user", "content": "x"}}, "m", nil, &owner, nil); err != nil {
		t.Fatal(err)
	}
	if c, _ := s.Get(id); len(c.Messages) != 1 || c.Title != "Hello 台北" {
		t.Errorf("after resave: %+v", c)
	}
	missing := int64(999)
	if _, err := s.Save(&missing, nil, "m", nil, &owner, nil); err == nil {
		t.Error("saving to a missing conversation should fail")
	}
	if ok, _ := s.Delete(id); !ok {
		t.Error("Delete")
	}
}
