package journal

import (
	"reflect"
	"testing"
)

func TestStructure(t *testing.T) {
	cases := []struct {
		in, level   string
		wantText    string
		wantLevel   string
		wantNFields int
	}{
		{`[INFO] Request 127.0.0.1 "GET /v1/models HTTP/1.1" 200 1799`, "info",
			`Request 127.0.0.1 "GET /v1/models HTTP/1.1" 200 1799`, "info", 0},
		{`[INFO] Request 127.0.0.1 "POST /v1/chat HTTP/1.1" 500 12`, "info",
			`Request 127.0.0.1 "POST /v1/chat HTTP/1.1" 500 12`, "error", 0},
		{`[WARN] slot is full`, "info", `slot is full`, "warn", 0},
		{`2026-09-14 10:00:00,123 ERROR app.main: boom`, "info", `app.main: boom`, "error", 0},
		{`INFO:     Started server`, "info", `Started server`, "info", 0},
		{`{"level":"error","ts":1.5,"logger":"http.log","msg":"failed","request":{"method":"GET","headers":{"A":["1","2"]}},"status":502}`, "info",
			`http.log: failed`, "error", 3},
		{`errors: 0, everything fine`, "info", `errors: 0, everything fine`, "info", 0},
		{`Traceback (most recent call last):`, "info", `Traceback (most recent call last):`, "info", 0},
	}
	for _, c := range cases {
		text, lvl, fields := structure(c.in, c.level)
		if text != c.wantText || lvl != c.wantLevel || len(fields) != c.wantNFields {
			t.Errorf("structure(%q) = (%q, %q, %d), want (%q, %q, %d)", c.in, text, lvl, len(fields), c.wantText, c.wantLevel, c.wantNFields)
		}
	}
}

func TestFieldsKeepWriterOrder(t *testing.T) {
	_, _, fields := structure(`{"msg":"m","zeta":1,"alpha":{"b":true,"a":null},"list":[1,"x"]}`, "info")
	want := [][2]string{{"zeta", "1"}, {"alpha.b", "True"}, {"alpha.a", "None"}, {"list", "1, x"}}
	if !reflect.DeepEqual(fields, want) {
		t.Errorf("fields = %v, want %v", fields, want)
	}
}

func TestKeywordLevel(t *testing.T) {
	if keywordLevel("errors: 0 warnings: none") != "info" {
		t.Error("a negated failure counted as one")
	}
	if keywordLevel("Exception in thread") != "error" || keywordLevel("Warning: slow") != "warn" {
		t.Error("keyword levels wrong")
	}
}

func TestContainerLineBlankIsDropped(t *testing.T) {
	if _, ok := parseContainerLine("comfyui-xpu", "2026-09-19T05:53:08.105911616Z"); ok {
		t.Fatal("a stamp with no message came through as a line")
	}
	if _, ok := parseContainerLine("comfyui-xpu", "2026-09-19T05:53:08.105911616Z   "); ok {
		t.Fatal("a stamp with only whitespace came through as a line")
	}
	line, ok := parseContainerLine("comfyui-xpu", "2026-09-19T05:53:08.105911616Z got prompt")
	if !ok || line.Text != "got prompt" || line.T < 1.7e9 {
		t.Fatalf("a real line parsed as %+v, %v", line, ok)
	}
}
