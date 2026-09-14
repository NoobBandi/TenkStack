// Package journal is one log stream for every part of the platform: the
// systemd journal for the user units, `docker logs` for the ComfyUI
// containers. One reader per source for the whole process feeds a shared
// buffer every connected client is served from.
package journal

import (
	"bufio"
	"context"
	"encoding/json"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
)

const (
	DefaultCapacity = 4000
	// Enough to fill a screen on arrival without a heavy first payload.
	Backfill = 400

	comfyPrefix = "comfyui"
	comfyLabel  = "圖像"
)

// UnitLabels is a copy of the unit table for the page.
func (j *Journal) UnitLabels() map[string]string {
	out := make(map[string]string, len(Units))
	for k, v := range Units {
		out[k] = v
	}
	return out
}

// Units are the user units followed, with the labels the page shows.
// init.scope is the user manager's own record of the units above starting
// and stopping, the only place a service that died on startup says so.
var Units = map[string]string{
	"llama-swap.service": "模型",
	"caddy.service":      "代理",
	"ai-console.service": "主控台",
	"init.scope":         "系統",
}

var unitOrder = []string{"llama-swap.service", "caddy.service", "ai-console.service", "init.scope"}

// xpu-smi writes MEI permission errors to syslog on every invocation.
var noiseIdentifiers = map[string]bool{"xpu-smi": true}

type Journal struct {
	mu          sync.Mutex
	capacity    int
	lines       []api.JournalLine
	subscribers map[chan api.JournalLine]struct{}
	followed    map[string]bool

	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func New() *Journal {
	return &Journal{
		capacity:    DefaultCapacity,
		subscribers: map[chan api.JournalLine]struct{}{},
		followed:    map[string]bool{},
	}
}

func (j *Journal) emit(line api.JournalLine) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.lines = append(j.lines, line)
	if len(j.lines) > j.capacity {
		j.lines = append([]api.JournalLine(nil), j.lines[len(j.lines)-j.capacity:]...)
	}
	for ch := range j.subscribers {
		select {
		case ch <- line:
		default: // a slow client loses lines rather than stalling the rest
		}
	}
}

func (j *Journal) History(limit int) []api.JournalLine {
	j.mu.Lock()
	defer j.mu.Unlock()
	// Zero or less is everything, as the Python slice [-0:] behaved.
	if limit <= 0 {
		limit = len(j.lines)
	}
	start := len(j.lines) - limit
	if start < 0 {
		start = 0
	}
	return append([]api.JournalLine{}, j.lines[start:]...)
}

// Subscribe returns a channel of new lines and the function that stops it.
func (j *Journal) Subscribe() (<-chan api.JournalLine, func()) {
	ch := make(chan api.JournalLine, 500)
	j.mu.Lock()
	j.subscribers[ch] = struct{}{}
	j.mu.Unlock()
	return ch, func() {
		j.mu.Lock()
		delete(j.subscribers, ch)
		j.mu.Unlock()
	}
}

// SetCapacity resizes the buffer, keeping the newest lines.
func (j *Journal) SetCapacity(lines int) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if lines == j.capacity {
		return
	}
	j.capacity = lines
	if len(j.lines) > lines {
		j.lines = append([]api.JournalLine(nil), j.lines[len(j.lines)-lines:]...)
	}
	log.Printf("log buffer resized to %d lines", lines)
}

func (j *Journal) Start(ctx context.Context) {
	if j.cancel != nil {
		return
	}
	ctx, j.cancel = context.WithCancel(ctx)
	j.wg.Add(2)
	go func() { defer j.wg.Done(); j.readJournal(ctx) }()
	go func() { defer j.wg.Done(); j.watchContainers(ctx) }()
	log.Print("log readers started (journal + docker)")
}

// Stop ends the readers and the followers they hold open; a follower that
// ignores SIGTERM is killed after a grace period so it cannot hold the
// service open.
func (j *Journal) Stop() {
	if j.cancel == nil {
		return
	}
	j.cancel()
	j.wg.Wait()
	j.cancel = nil
}

// follower builds a long-lived child that is terminated, then killed, when
// ctx ends.
func follower(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = 3 * time.Second
	return cmd
}

func sleep(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

func (j *Journal) readJournal(ctx context.Context) {
	args := []string{"--user", "-o", "json", "--follow", "-n", strconv.Itoa(Backfill), "--no-pager"}
	for _, unit := range unitOrder {
		args = append(args, "-u", unit)
	}
	if _, err := exec.LookPath("journalctl"); err != nil {
		return // no journal: a missing feature, not a failure to report
	}
	for {
		cmd := follower(ctx, "journalctl", args...)
		out, err := cmd.StdoutPipe()
		if err != nil || cmd.Start() != nil {
			return
		}
		sc := bufio.NewScanner(out)
		sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for sc.Scan() {
			if line, ok := parseJournalEntry(sc.Bytes()); ok {
				j.emit(line)
			}
		}
		cmd.Wait()
		// journalctl exited: a rotation or a killed process. Wait before
		// respawning so a permanent failure does not become a spin.
		if !sleep(ctx, 5*time.Second) {
			return
		}
	}
}

func parseJournalEntry(raw []byte) (api.JournalLine, bool) {
	var entry map[string]any
	if json.Unmarshal(raw, &entry) != nil {
		return api.JournalLine{}, false
	}
	if id, _ := entry["SYSLOG_IDENTIFIER"].(string); noiseIdentifiers[id] {
		return api.JournalLine{}, false
	}
	var message string
	switch m := entry["MESSAGE"].(type) {
	case string:
		message = m
	case []any: // binary payloads arrive as an array of byte values
		b := make([]byte, 0, len(m))
		for _, v := range m {
			if f, ok := v.(float64); ok {
				b = append(b, byte(f))
			}
		}
		message = strings.ToValidUTF8(string(b), "�")
	}
	if message == "" {
		return api.JournalLine{}, false
	}
	unit, _ := entry["_SYSTEMD_USER_UNIT"].(string)
	if unit == "" {
		unit, _ = entry["UNIT"].(string)
	}
	seconds := float64(time.Now().UnixNano()) / 1e9
	if stamp, _ := entry["__REALTIME_TIMESTAMP"].(string); stamp != "" {
		if us, err := strconv.ParseInt(stamp, 10, 64); err == nil {
			seconds = float64(us) / 1e6
		}
	}
	priority := 6
	if p, _ := entry["PRIORITY"].(string); p != "" {
		if n, err := strconv.Atoi(p); err == nil {
			priority = n
		}
	}
	clean := strings.TrimRight(ansi.ReplaceAllString(message, ""), " \t\r\n")
	summary, lvl, fields := structure(clean, level(priority))
	label, known := Units[unit]
	if !known {
		label = unit
		if label == "" {
			label = "系統"
		}
	}
	return api.JournalLine{T: seconds, Unit: unit, Label: label, Level: lvl, Text: summary, Fields: fields}, true
}

// containers lists the ComfyUI containers that exist, running or not: a
// stopped one still holds the log of how it stopped.
func containers(ctx context.Context) []string {
	out, err := exec.CommandContext(ctx, "docker", "ps", "-a", "--format", "{{.Names}}", "--filter", "name="+comfyPrefix).Output()
	if err != nil {
		return nil
	}
	return strings.Fields(string(out))
}

func (j *Journal) watchContainers(ctx context.Context) {
	for {
		for _, name := range containers(ctx) {
			j.mu.Lock()
			seen := j.followed[name]
			if !seen {
				j.followed[name] = true
			}
			j.mu.Unlock()
			if !seen {
				j.wg.Add(1)
				go func(name string) { defer j.wg.Done(); j.readContainer(ctx, name) }(name)
				log.Printf("following container %s", name)
			}
		}
		if !sleep(ctx, 60*time.Second) {
			return
		}
	}
}

func (j *Journal) readContainer(ctx context.Context, name string) {
	for {
		cmd := follower(ctx, "docker", "logs", "--follow", "--timestamps", "--tail", "200", name)
		out, err := cmd.StdoutPipe()
		if err != nil {
			return
		}
		cmd.Stderr = cmd.Stdout
		if cmd.Start() != nil {
			return
		}
		sc := bufio.NewScanner(out)
		sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for sc.Scan() {
			if line, ok := parseContainerLine(name, sc.Text()); ok {
				j.emit(line)
			}
		}
		cmd.Wait()
		if ctx.Err() != nil {
			return
		}
		// A removed container never produces another line; forget it so the
		// watcher can pick it up again if it comes back.
		gone := true
		for _, n := range containers(ctx) {
			if n == name {
				gone = false
			}
		}
		if gone {
			j.mu.Lock()
			delete(j.followed, name)
			j.mu.Unlock()
			log.Printf("stopped following container %s: it is gone", name)
			return
		}
		if !sleep(ctx, 5*time.Second) {
			return
		}
	}
}

func parseContainerLine(name, raw string) (api.JournalLine, bool) {
	text := strings.TrimRight(strings.ToValidUTF8(raw, "�"), " \t\r\n")
	if text == "" {
		return api.JournalLine{}, false
	}
	seconds := float64(time.Now().UnixNano()) / 1e9
	// --timestamps prefixes RFC3339; split it back off so the line sorts
	// with the journal's rather than carrying its own clock.
	if stamp, rest, ok := strings.Cut(text, " "); ok && strings.HasSuffix(stamp, "Z") && strings.Contains(stamp, "T") {
		if ts, err := time.Parse(time.RFC3339Nano, stamp); err == nil {
			seconds = float64(ts.UnixNano()) / 1e9
			text = rest
		}
	}
	clean := ansi.ReplaceAllString(text, "")
	summary, lvl, fields := structure(clean, keywordLevel(clean))
	return api.JournalLine{T: seconds, Unit: name, Label: comfyLabel, Level: lvl, Text: summary, Fields: fields}, true
}
