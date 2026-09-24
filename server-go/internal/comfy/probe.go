// Package comfy finds, creates and drives the ComfyUI instances, one per
// card. Instances are probed, never configured: a listed-but-absent
// instance is wrong in both directions.
package comfy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
)

const Prefix = "comfyui"

// Which catalogue Manager consults. 'local' because the other two send
// Manager to a channel URL it then fails to validate; the catalogue is only
// for discovering nodes, and updates run the same way under every mode.
const managerMode = "local"

// Long enough that a permanently Manager-less instance costs nothing,
// short enough that installing Manager into a running one is noticed.
const managerRecheck = 600 * time.Second

// How often the newest ComfyUI release is asked for. One remote call, but a
// remote call on a three-second poll would be forty minutes of GitHub an
// hour for a number that changes every few weeks.
const latestRecheck = time.Hour

// Published lists the ports the ComfyUI containers publish right now, and
// which container each belongs to.
type Published interface {
	PublishedPorts(ctx context.Context, prefix string) map[int]string
}

type Probe struct {
	// Ports is the fixed range the console looks at without being told.
	Ports        []int
	PublicOffset int
	PublicOpen   func(port int) bool
	Docker       Published

	mu            sync.Mutex
	seen          map[int]api.ComfyInstance
	managerAbsent map[int]time.Time
	latest        map[int]latestRelease
	afterUpdate   map[int]string
	client        *http.Client
	long          *http.Client
}

// latestRelease is one port's answer to "is there a newer ComfyUI", and
// whether a fresh answer is on its way.
type latestRelease struct {
	version  string
	at       time.Time
	inflight bool
}

func NewProbe(ports []int, publicOffset int, publicOpen func(int) bool, docker Published) *Probe {
	// Short connect, long read: three of the four ports have nothing on them
	// and must be dismissed instantly, while the one that answers may be
	// mid-step.
	dialer := &net.Dialer{Timeout: 500 * time.Millisecond}
	return &Probe{
		Ports: ports, PublicOffset: publicOffset, PublicOpen: publicOpen, Docker: docker,
		seen: map[int]api.ComfyInstance{}, managerAbsent: map[int]time.Time{}, latest: map[int]latestRelease{},
		afterUpdate: map[int]string{},
		client:      &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{DialContext: dialer.DialContext}},
		long:        &http.Client{Transport: &http.Transport{DialContext: dialer.DialContext}},
	}
}

func base(port int) string { return fmt.Sprintf("http://127.0.0.1:%d", port) }

func (p *Probe) InRange(port int) bool {
	for _, known := range p.Ports {
		if known == port {
			return true
		}
	}
	return false
}

func refused(err error) bool {
	var op *net.OpError
	return errors.As(err, &op) && errors.Is(err, syscall.ECONNREFUSED)
}

func (p *Probe) get(ctx context.Context, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	return p.client.Do(req)
}

func decode(resp *http.Response) (map[string]any, error) {
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var v map[string]any
	return v, json.NewDecoder(resp.Body).Decode(&v)
}

// Instance is one port's ComfyUI, or nil when nothing answers there. A
// refused connection means gone; a timeout means busy, and the last known
// record is reported flagged stale.
func (p *Probe) Instance(ctx context.Context, port int) *api.ComfyInstance {
	var stats, queue map[string]any
	var errStats, errQueue error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		resp, err := p.get(ctx, base(port)+"/system_stats")
		if err == nil {
			stats, err = decode(resp)
		}
		errStats = err
	}()
	go func() {
		defer wg.Done()
		resp, err := p.get(ctx, base(port)+"/queue")
		if err == nil {
			queue, err = decode(resp)
		}
		errQueue = err
	}()
	wg.Wait()
	if err := errors.Join(errStats, errQueue); err != nil {
		p.mu.Lock()
		defer p.mu.Unlock()
		if refused(errStats) || refused(errQueue) {
			delete(p.seen, port)
			return nil
		}
		if stale, ok := p.seen[port]; ok {
			stale.Stale = true
			return &stale
		}
		return nil
	}

	p.mu.Lock()
	previous, had := p.seen[port]
	absentUntil := p.managerAbsent[port]
	p.mu.Unlock()
	var manager *api.ComfyManager
	if had {
		manager = previous.Manager
	}
	// Manager is a custom node, so its absence is ordinary. Asked on every
	// poll so progress survives a reload, except on an instance that has said
	// it does not have it, which is a fact about the image.
	if time.Now().After(absentUntil) {
		resp, err := p.get(ctx, base(port)+"/api/manager/queue/status")
		if err == nil {
			if resp.StatusCode == 404 {
				resp.Body.Close()
				p.mu.Lock()
				p.managerAbsent[port] = time.Now().Add(managerRecheck)
				p.mu.Unlock()
				manager = nil
			} else if m, err := decode(resp); err == nil {
				p.mu.Lock()
				delete(p.managerAbsent, port)
				p.mu.Unlock()
				processing, _ := m["is_processing"].(bool)
				manager = &api.ComfyManager{Processing: processing, Done: orZero(m["done_count"]), Total: orZero(m["total_count"])}
			}
		}
	}

	system, _ := stats["system"].(map[string]any)
	devices, _ := stats["devices"].([]any)
	record := api.ComfyInstance{Port: port, Manager: manager}
	if manager != nil {
		// Reported from the cache and refreshed behind the poll: the answer
		// takes a second or two and the poll must not.
		p.mu.Lock()
		rel := p.latest[port]
		due := !rel.inflight && time.Since(rel.at) >= latestRecheck
		if due {
			rel.inflight = true
			p.latest[port] = rel
		}
		p.mu.Unlock()
		if rel.version != "" {
			v := rel.version
			at := float64(rel.at.UnixNano()) / 1e9
			record.Latest, record.LatestCheckedAt = &v, &at
		}
		if due {
			go p.refreshLatest(context.Background(), port)
		}
	}
	if public := port + p.PublicOffset; p.PublicOpen != nil && p.PublicOpen(public) {
		record.PublicPort = &public
	}
	if system != nil {
		record.Version = system["comfyui_version"]
		record.Torch = system["pytorch_version"]
		if py, _ := system["python_version"].(string); py != "" {
			if f := strings.Fields(py); len(f) > 0 {
				record.Python = f[0]
			}
		}
	}
	if len(devices) > 0 {
		record.Device, _ = devices[0].(map[string]any)
	}
	if q, _ := queue["queue_running"].([]any); q != nil {
		record.QueueRunning = len(q)
	}
	if q, _ := queue["queue_pending"].([]any); q != nil {
		record.QueuePending = len(q)
	}
	p.mu.Lock()
	p.seen[port] = record
	p.mu.Unlock()
	return &record
}

func orZero(v any) any {
	if v == nil {
		return 0
	}
	return v
}

// AllPorts is where to look: the fixed range plus whatever the containers
// actually publish, since an instance moved elsewhere still exists. The
// map says which container publishes a port, for the ones that are known.
func (p *Probe) AllPorts(ctx context.Context) ([]int, map[int]string) {
	names := map[int]string{}
	set := map[int]bool{}
	for _, port := range p.Ports {
		set[port] = true
	}
	if p.Docker != nil {
		for port, name := range p.Docker.PublishedPorts(ctx, Prefix) {
			set[port] = true
			names[port] = name
		}
	}
	out := make([]int, 0, len(set))
	for port := range set {
		out = append(out, port)
	}
	sort.Ints(out)
	return out, names
}

func (p *Probe) probeAll(ctx context.Context, ports []int, names map[int]string) []api.ComfyInstance {
	found := make([]*api.ComfyInstance, len(ports))
	var wg sync.WaitGroup
	for i, port := range ports {
		wg.Add(1)
		go func(i, port int) { defer wg.Done(); found[i] = p.Instance(ctx, port) }(i, port)
	}
	wg.Wait()
	out := []api.ComfyInstance{}
	for _, inst := range found {
		if inst != nil {
			if name, ok := names[inst.Port]; ok {
				inst.Container = &name
			}
			out = append(out, *inst)
		}
	}
	return out
}

// Instances is every ComfyUI on this machine, in port order.
func (p *Probe) Instances(ctx context.Context) []api.ComfyInstance {
	ports, names := p.AllPorts(ctx)
	found := p.probeAll(ctx, ports, names)
	for i := range found {
		found[i].AfterUpdate = p.AfterUpdate(found[i].Port)
	}
	return found
}

// Held is an instance holding VRAM and how much.
type Held struct {
	Instance api.ComfyInstance
	Bytes    float64
}

// HeldVRAM is the instances holding more than an idle amount, every card.
func (p *Probe) HeldVRAM(ctx context.Context, idle float64) []Held {
	var out []Held
	for _, inst := range p.probeAll(ctx, p.Ports, nil) {
		held, _ := inst.Device["torch_vram_total"].(float64)
		if held >= idle {
			out = append(out, Held{inst, held})
		}
	}
	return out
}

// Upstream is an error from an instance, worth a 502.
type Upstream struct{ Msg string }

func (e *Upstream) Error() string { return e.Msg }

// Refused is Manager declining an update, with the status it used.
type Refused struct {
	Status int
	Msg    string
}

func (e *Refused) Error() string { return e.Msg }

func (p *Probe) post(ctx context.Context, timeout time.Duration, url string, body any) (*http.Response, error) {
	var payload io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		payload = bytes.NewReader(b)
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, payload)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := p.long.Do(req)
	if err != nil {
		return nil, err
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp, nil
}

// refreshLatest asks Manager for the ComfyUI releases it knows of and
// keeps the newest. One git call against ComfyUI's own repository.
func (p *Probe) refreshLatest(ctx context.Context, port int) (string, error) {
	found, err := p.newestRelease(ctx, port)
	p.mu.Lock()
	rel := p.latest[port]
	rel.inflight = false
	if err == nil {
		rel.version = found
		rel.at = time.Now()
	} else if rel.version == "" {
		// Nothing to show yet; retry sooner than the hour, but not on the
		// next poll, since an instance without a route to GitHub stays that way.
		rel.at = time.Now().Add(-latestRecheck + 5*time.Minute)
	}
	p.latest[port] = rel
	p.mu.Unlock()
	return found, err
}

func (p *Probe) newestRelease(ctx context.Context, port int) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base(port)+"/api/comfyui_manager/comfyui_versions", nil)
	if err != nil {
		return "", err
	}
	resp, err := p.long.Do(req)
	if err != nil {
		return "", err
	}
	body, err := decode(resp)
	if err != nil {
		return "", err
	}
	// Newest first, with "nightly" ahead of the numbered ones.
	list, _ := body["versions"].([]any)
	for _, item := range list {
		if v, _ := item.(string); strings.HasPrefix(v, "v") {
			return v, nil
		}
	}
	return "", errors.New("Manager listed no releases")
}

// LatestVersion asks for the newest release now rather than waiting for
// the hourly pass, and says how it compares to what is running.
func (p *Probe) LatestVersion(ctx context.Context, port int) (api.ComfyRelease, error) {
	latest, err := p.refreshLatest(ctx, port)
	if err != nil {
		return api.ComfyRelease{}, &Upstream{err.Error()}
	}
	p.mu.Lock()
	current, _ := p.seen[port].Version.(string)
	p.mu.Unlock()
	out := api.ComfyRelease{Latest: &latest}
	if current != "" {
		// system_stats says "0.36.0"; the release list says "v0.36.0".
		c := "v" + strings.TrimPrefix(current, "v")
		out.Current = &c
		out.Available = c != latest
	}
	return out, nil
}

// Update queues core and nodes, in Manager's own order, and starts the
// worker. 201 on start means one was already running.
func (p *Probe) Update(ctx context.Context, port int, core, nodes bool) error {
	if core {
		resp, err := p.post(ctx, 300*time.Second, base(port)+"/api/manager/queue/update_comfyui", map[string]any{})
		if err != nil {
			return &Upstream{err.Error()}
		}
		if resp.StatusCode >= 400 {
			return &Upstream{fmt.Sprintf("HTTP %d", resp.StatusCode)}
		}
	}
	if nodes {
		resp, err := p.post(ctx, 300*time.Second, base(port)+"/api/manager/queue/update_all", map[string]any{"mode": managerMode})
		if err != nil {
			return &Upstream{err.Error()}
		}
		switch {
		case resp.StatusCode == 401:
			return &Refused{409, "更新已在進行中"}
		case resp.StatusCode == 403:
			return &Refused{403, "ComfyUI-Manager 的 security_level 不允許更新"}
		case resp.StatusCode >= 400:
			return &Upstream{fmt.Sprintf("HTTP %d", resp.StatusCode)}
		}
	}
	resp, err := p.post(ctx, 300*time.Second, base(port)+"/api/manager/queue/start", map[string]any{})
	if err != nil {
		return &Upstream{err.Error()}
	}
	if resp.StatusCode != 200 && resp.StatusCode != 201 {
		return &Upstream{fmt.Sprintf("HTTP %d", resp.StatusCode)}
	}
	return nil
}

// Restart asks Manager to reboot. It execs over its own process, so a
// dropped connection is the success case.
func (p *Probe) Restart(ctx context.Context, port int) {
	p.post(ctx, 10*time.Second, base(port)+"/api/manager/reboot", map[string]any{})
}

func (p *Probe) Interrupt(ctx context.Context, port int) (bool, error) {
	resp, err := p.post(ctx, 5*time.Second, base(port)+"/interrupt", nil)
	if err != nil {
		return false, &Upstream{err.Error()}
	}
	return resp.StatusCode == 200 || resp.StatusCode == 204, nil
}

// Quiesce empties the queue and interrupts whatever is being generated,
// then waits for the worker to actually stop, so a container about to be
// stopped is not killed mid-step. docker stop gives the process ten
// seconds and ComfyUI's launcher does not pass the signal on, so without
// this a running generation ends in SIGKILL and the picture is lost.
// Pending prompts are cleared first: interrupting alone would start the
// next one. Best effort; a container that is not answering is stopped
// anyway.
func (p *Probe) Quiesce(ctx context.Context, port int, wait time.Duration) {
	p.post(ctx, 5*time.Second, base(port)+"/queue", map[string]any{"clear": true})
	p.post(ctx, 5*time.Second, base(port)+"/interrupt", nil)
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		resp, err := p.get(ctx, base(port)+"/queue")
		if err != nil {
			return
		}
		queue, err := decode(resp)
		if err != nil {
			return
		}
		running, _ := queue["queue_running"].([]any)
		if len(running) == 0 {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(500 * time.Millisecond):
		}
	}
}

// Free asks an instance to unload its models; it returns as soon as the
// flag is set, so the caller waits for the memory to actually go.
func (p *Probe) Free(ctx context.Context, port int) error {
	_, err := p.post(ctx, 10*time.Second, base(port)+"/free", map[string]any{"unload_models": true, "free_memory": true})
	return err
}

// SetAfterUpdate records where the restart following an update stands.
func (p *Probe) SetAfterUpdate(port int, phase string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if phase == "" {
		delete(p.afterUpdate, port)
	} else {
		p.afterUpdate[port] = phase
	}
}

func (p *Probe) AfterUpdate(port int) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.afterUpdate[port]
}

// managerState is Manager's own queue: whether it is working, and how far.
func (p *Probe) managerState(ctx context.Context, port int) (processing bool, done, total int, ok bool) {
	resp, err := p.get(ctx, base(port)+"/api/manager/queue/status")
	if err != nil {
		return false, 0, 0, false
	}
	m, err := decode(resp)
	if err != nil {
		return false, 0, 0, false
	}
	processing, _ = m["is_processing"].(bool)
	d, _ := m["done_count"].(float64)
	t, _ := m["total_count"].(float64)
	return processing, int(d), int(t), true
}

// renderQueue is how many prompts are running and waiting.
func (p *Probe) renderQueue(ctx context.Context, port int) (int, bool) {
	resp, err := p.get(ctx, base(port)+"/queue")
	if err != nil {
		return 0, false
	}
	queue, err := decode(resp)
	if err != nil {
		return 0, false
	}
	running, _ := queue["queue_running"].([]any)
	pending, _ := queue["queue_pending"].([]any)
	return len(running) + len(pending), true
}

// AwaitUpdate follows an update Manager was just asked for until it is
// finished and ComfyUI has nothing left to draw, which is when a restart
// costs nobody a picture. It returns false when the update never started,
// never finished, or the instance went away, and says nothing of whether
// every node updated -- Manager's queue reports counts, not outcomes.
func (p *Probe) AwaitUpdate(ctx context.Context, port int) bool {
	sleep := func(d time.Duration) bool {
		select {
		case <-ctx.Done():
			return false
		case <-time.After(d):
			return true
		}
	}
	// The worker is started by the same request, but the first status can
	// still read idle; a queue that never shows work was empty.
	started := false
	for i := 0; i < 20 && !started; i++ {
		processing, _, total, ok := p.managerState(ctx, port)
		if ok && (processing || total > 0) {
			started = true
			break
		}
		if !sleep(time.Second) {
			return false
		}
	}
	// Forty custom nodes each fetch and pip-install; an hour is generous.
	deadline := time.Now().Add(time.Hour)
	for started && time.Now().Before(deadline) {
		processing, _, _, ok := p.managerState(ctx, port)
		if ok && !processing {
			break
		}
		if !sleep(3 * time.Second) {
			return false
		}
	}
	if time.Now().After(deadline) {
		return false
	}
	p.SetAfterUpdate(port, "waiting")
	// A render in progress finishes first; a queue somebody left running
	// for hours does not hold the update back for longer than that.
	wait := time.Now().Add(2 * time.Hour)
	for time.Now().Before(wait) {
		n, ok := p.renderQueue(ctx, port)
		if !ok || n == 0 {
			break
		}
		if !sleep(5 * time.Second) {
			return false
		}
	}
	return true
}
