package users

import (
	"testing"

	"github.com/NoobBandi/TenkStack/internal/store/storetest"
)

func TestAccountsAndKeys(t *testing.T) {
	s := New(storetest.New(t))
	u, err := s.Create("owner", "pw", "", "admin")
	if err != nil || u.ID == 0 || u.DisplayName != "owner" {
		t.Fatalf("Create = %+v, %v", u, err)
	}
	if _, err := s.Create("owner", "pw2", "", "member"); err == nil || err.Error() != "UNIQUE constraint failed: users.username" {
		t.Errorf("duplicate username: %v", err)
	}
	if got, _ := s.VerifyPassword("owner", "pw"); got == nil || got.ID != u.ID {
		t.Errorf("VerifyPassword right = %v", got)
	}
	if got, _ := s.VerifyPassword("owner", "nope"); got != nil {
		t.Error("VerifyPassword accepted a wrong password")
	}

	key, err := s.CreateAPIKey(u.ID, "pi")
	if err != nil || key.ID == 0 {
		t.Fatalf("CreateAPIKey = %+v, %v", key, err)
	}
	id, err := s.VerifyAPIKey(key.Secret)
	if err != nil || id == nil || id.UserID != u.ID {
		t.Fatalf("VerifyAPIKey = %+v, %v", id, err)
	}
	keys, _ := s.ListAPIKeys()
	if len(keys) != 1 || keys[0].LastUsedAt == nil {
		t.Errorf("the key should show its last use: %+v", keys)
	}
	rows, _ := s.List()
	if len(rows) != 1 || rows[0].KeyCount != 1 {
		t.Errorf("List = %+v", rows)
	}

	// Deleting the account takes its keys with it.
	if ok, _ := s.Delete(u.ID); !ok {
		t.Fatal("Delete")
	}
	if id, _ := s.VerifyAPIKey(key.Secret); id != nil {
		t.Error("a deleted account's key still works")
	}
}
