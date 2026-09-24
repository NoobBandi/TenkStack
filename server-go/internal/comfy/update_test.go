package comfy

import (
	"context"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

// Manager's report: "skip" is current, "success…" changed files, anything
// else is the error it hit.
func TestOutcomeOf(t *testing.T) {
	o := outcomeOf(map[string]string{
		"comfyui":          "skip",
		"rgthree-comfy":    "skip",
		"ComfyUI-KJNodes":  "success",
		"ComfyUI-GGUF":     "An error occurred while updating 'ComfyUI-GGUF'.",
		"was-node-suite":   "skip",
		"comfyui-core-alt": "success-stable-v0.37.3",
	}, "0.37.2")
	if !o.Known || o.Checked != 6 {
		t.Fatalf("outcome = %+v", o)
	}
	if len(o.Updated) != 2 || o.Updated[0] != "ComfyUI-KJNodes" || o.Updated[1] != "comfyui-core-alt" {
		t.Errorf("updated = %v", o.Updated)
	}
	if len(o.Failed) != 1 || o.Failed[0] != "ComfyUI-GGUF" {
		t.Errorf("failed = %v", o.Failed)
	}
	if all := outcomeOf(map[string]string{"a": "skip", "b": "skip"}, ""); len(all.Updated) != 0 || len(all.Failed) != 0 {
		t.Errorf("all skipped = %+v", all)
	}
	// Manager reports the running release as "updated"; it is not.
	if same := outcomeOf(map[string]string{"comfyui": "success-stable-v0.37.2", "x": "skip"}, "0.37.2"); len(same.Updated) != 0 {
		t.Errorf("same release counted as a change: %+v", same)
	}
}

// The report is read off ComfyUI's websocket: status frames and binary
// previews are passed over, the done report is returned once.
func TestWatchManagerReadsTheDoneReport(t *testing.T) {
	srv := httptest.NewServer(websocket.Handler(func(ws *websocket.Conn) {
		websocket.Message.Send(ws, `{"type":"status","data":{"status":{"exec_info":{"queue_remaining":0}}}}`)
		websocket.Message.Send(ws, []byte{1, 2, 3})
		websocket.Message.Send(ws, `{"type":"cm-queue-status","data":{"status":"in_progress","ui_target":"nodepack_manager"}}`)
		websocket.Message.Send(ws, `{"type":"cm-queue-status","data":{"status":"done","nodepack_result":{"comfyui":"skip","ComfyUI-KJNodes":"success"},"total_count":2,"done_count":2}}`)
		time.Sleep(100 * time.Millisecond)
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	p := NewProbe(nil, 0, func(int) bool { return false }, nil)
	ch, err := p.WatchManager(context.Background(), port)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case r := <-ch:
		o := outcomeOf(r, "")
		if o.Checked != 2 || len(o.Updated) != 1 || o.Updated[0] != "ComfyUI-KJNodes" {
			t.Errorf("outcome = %+v", o)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no report")
	}
}
