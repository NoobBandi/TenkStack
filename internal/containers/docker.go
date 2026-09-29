package containers

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"

	"github.com/NoobBandi/TenkStack/internal/api"
)

// Command runs one docker command and returns its stdout. The verbs the
// console uses are fixed by their callers; nothing here takes a free-form
// command from a request.
func (d *Docker) Command(ctx context.Context, args ...string) (string, bool) {
	return d.run(ctx, args...)
}

// Pull fetches an image, reporting layers and bytes into progress.
//
// A non-interactive `docker pull` prints a line when a layer changes state
// and nothing while it downloads, so one large layer held a bar still for
// minutes and looked like a hang. The Engine API streams each layer's bytes
// as JSON, and is used whenever the socket is there; the CLI is the
// fallback, counting layers only.
func (d *Docker) Pull(ctx context.Context, image string, progress api.Progress) bool {
	if ok, tried := pullAPI(ctx, image, progress); tried {
		return ok
	}
	return pullCLI(ctx, image, progress)
}

// dockerSocket is the Engine's unix socket: DOCKER_HOST when it names one,
// else the usual path.
func dockerSocket() string {
	if host := os.Getenv("DOCKER_HOST"); strings.HasPrefix(host, "unix://") {
		return strings.TrimPrefix(host, "unix://")
	}
	if host := os.Getenv("DOCKER_HOST"); host != "" {
		return ""
	}
	return "/var/run/docker.sock"
}

// pullAPI pulls through POST /images/create. tried is false when the socket
// cannot be reached, so the CLI can try instead.
func pullAPI(ctx context.Context, image string, progress api.Progress) (ok, tried bool) {
	sock := dockerSocket()
	if sock == "" {
		return false, false
	}
	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", sock)
		},
	}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"http://docker/images/create?fromImage="+url.QueryEscape(image), nil)
	if err != nil {
		return false, false
	}
	resp, err := client.Do(req)
	if err != nil {
		return false, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2000))
		var e struct {
			Message string `json:"message"`
		}
		json.Unmarshal(body, &e)
		progress.Failed(e.Message)
		return false, true
	}
	t := newPullTracker(progress)
	dec := json.NewDecoder(resp.Body)
	for {
		var ev pullEvent
		if err := dec.Decode(&ev); err != nil {
			if err == io.EOF {
				break
			}
			progress.Failed(err.Error())
			return false, true
		}
		if ev.Error != "" {
			progress.Failed(ev.Error)
			return false, true
		}
		t.event(ev)
	}
	return true, true
}

// pullEvent is one line of the Engine's pull stream.
type pullEvent struct {
	Status   string `json:"status"`
	ID       string `json:"id"`
	Error    string `json:"error"`
	Progress struct {
		Current int64 `json:"current"`
		Total   int64 `json:"total"`
	} `json:"progressDetail"`
}

// pullTracker turns layer events into progress. Layers are counted by id,
// so one already on the machine -- which says "Already exists" and never
// "Pulling fs layer" -- is one of the total as well as one done.
type pullTracker struct {
	progress api.Progress
	order    []string
	layers   map[string]*layerState
}

type layerState struct {
	done           bool
	current, total int64
}

func newPullTracker(p api.Progress) *pullTracker {
	return &pullTracker{progress: p, layers: map[string]*layerState{}}
}

// layerStatuses are the statuses a layer id carries; an id with any other
// status -- the tag being pulled, the digest line -- is not a layer.
var layerStatuses = map[string]bool{"Pulling fs layer": true, "Waiting": true, "Downloading": true,
	"Verifying Checksum": true, "Download complete": true, "Extracting": true, "Pull complete": true,
	"Already exists": true}

// startsLayer are the statuses that make an id a layer.
var startsLayer = map[string]bool{"Pulling fs layer": true, "Waiting": true, "Downloading": true, "Already exists": true}

func (t *pullTracker) event(ev pullEvent) {
	if ev.ID == "" || !layerStatuses[ev.Status] {
		if ev.Status != "" {
			msg := ev.Status
			if ev.ID != "" {
				msg = ev.ID + ": " + msg
			}
			t.progress.Message(truncate(msg))
		}
		return
	}
	l, ok := t.layers[ev.ID]
	if !ok {
		// With the containerd image store the config blob says "Download
		// complete" and nothing else; only an id announced as a layer, or
		// seen downloading, is one.
		if !startsLayer[ev.Status] {
			return
		}
		l = &layerState{}
		t.layers[ev.ID] = l
		t.order = append(t.order, ev.ID)
	}
	switch ev.Status {
	case "Downloading":
		l.current = ev.Progress.Current
		if ev.Progress.Total > 0 {
			l.total = ev.Progress.Total
		}
	case "Download complete", "Extracting":
		l.current = l.total
	case "Pull complete", "Already exists":
		l.current, l.done = l.total, true
	}
	done := 0
	var got, want int64
	for _, id := range t.order {
		s := t.layers[id]
		if s.done {
			done++
		}
		got += s.current
		want += s.total
	}
	t.progress.Layer(done, len(t.order))
	if want > 0 {
		t.progress.Bytes(got, want)
	}
	t.progress.Message(truncate(ev.ID + ": " + ev.Status))
}

func truncate(s string) string {
	if len(s) > 200 {
		return s[:200]
	}
	return s
}

// pullCLI is the fallback: docker pull's own lines, layers by id.
func pullCLI(ctx context.Context, image string, progress api.Progress) bool {
	cmd := exec.CommandContext(ctx, "docker", "pull", image)
	out, err := cmd.StdoutPipe()
	if err != nil {
		progress.Failed(err.Error())
		return false
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		progress.Failed(err.Error())
		return false
	}
	t := newPullTracker(progress)
	sc := bufio.NewScanner(out)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		// "<id>: <status>" for a layer, anything else is a message.
		if id, status, ok := strings.Cut(line, ": "); ok && layerStatuses[status] {
			t.event(pullEvent{ID: id, Status: status})
		} else if line != "" {
			progress.Message(truncate(line))
		}
	}
	if err := cmd.Wait(); err != nil {
		progress.Failed("")
		return false
	}
	return true
}

// RemoveImage runs docker rmi, logging rather than failing when the image
// is still in use.
func (d *Docker) RemoveImage(ctx context.Context, image string) bool {
	_, ok := d.run(ctx, "rmi", image)
	if !ok {
		log.Printf("could not remove %s", image)
	}
	return ok
}

// PublishedPorts maps each host port the ComfyUI containers publish to the
// container publishing it, running ones only.
func (d *Docker) PublishedPorts(ctx context.Context, prefix string) map[int]string {
	listing, _ := d.run(ctx, "ps", "--filter", "name="+prefix, "--format", "{{.Names}}\t{{.Ports}}")
	out := map[int]string{}
	for _, line := range strings.Split(listing, "\n") {
		name, ports, ok := strings.Cut(line, "\t")
		if !ok {
			continue
		}
		for _, m := range published.FindAllStringSubmatch(ports, -1) {
			n := 0
			for _, ch := range m[1] {
				n = n*10 + int(ch-'0')
			}
			out[n] = strings.TrimSpace(name)
		}
	}
	return out
}
