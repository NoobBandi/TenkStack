package containers

import "testing"

type recorder struct {
	done, total        int
	gotBytes, allBytes int64
}

func (r *recorder) Layer(done, total int)   { r.done, r.total = done, total }
func (r *recorder) Bytes(done, total int64) { r.gotBytes, r.allBytes = done, total }
func (r *recorder) Message(string)          {}
func (r *recorder) Failed(string)           {}

// A layer already on the machine counts toward the total, not only toward
// done, and bytes follow the layer being downloaded.
func TestPullTracker(t *testing.T) {
	r := &recorder{}
	tr := newPullTracker(r)
	ev := func(id, status string, cur, tot int64) {
		e := pullEvent{ID: id, Status: status}
		e.Progress.Current, e.Progress.Total = cur, tot
		tr.event(e)
	}
	ev("server-intel", "Pulling from ggml-org/llama.cpp", 0, 0)
	ev("a", "Already exists", 0, 0)
	ev("b", "Pulling fs layer", 0, 0)
	ev("c", "Pulling fs layer", 0, 0)
	ev("b", "Downloading", 100, 1000)
	ev("c", "Downloading", 50, 100)
	if r.done != 1 || r.total != 3 || r.gotBytes != 150 || r.allBytes != 1100 {
		t.Fatalf("mid-pull: %+v", r)
	}
	ev("c", "Download complete", 0, 0)
	ev("c", "Pull complete", 0, 0)
	ev("b", "Downloading", 900, 1000)
	if r.done != 2 || r.gotBytes != 1000 {
		t.Fatalf("after c: %+v", r)
	}
	ev("b", "Pull complete", 0, 0)
	// The containerd store's config blob: "Download complete" only.
	ev("cfg", "Download complete", 0, 0)
	if r.done != 3 || r.total != 3 || r.gotBytes != r.allBytes {
		t.Fatalf("finished: %+v", r)
	}
}
