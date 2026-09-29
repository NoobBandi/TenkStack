package journal

import (
	"bufio"
	"context"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/NoobBandi/TenkStack/internal/api"
)

// The durable side of the log. The buffer the followers fill is what a
// connected page tails; it starts when the console starts and holds a few
// thousand lines. The systemd journal and docker's log files are where the
// history actually lives -- days of it -- and a question about last night
// is answered from there, by running the same readers over a time range
// instead of following.

// How many lines a query will read before stopping. Measured here: the
// journal gives up about 33,000 lines a second as JSON, and a week of
// llama-swap at the console's own polling rate is eight hundred thousand,
// so an uncapped week is twenty-five seconds. The read runs newest first,
// so what the cap cuts is the far end of the window, and the answer says
// how far back it got.
const scanCap = 150000

// Query is one request against the history: a window, which sources, how
// bad, a substring. Units is by unit or container name; empty means all.
type Query struct {
	Since  time.Time
	Until  time.Time
	Units  map[string]bool
	Levels map[string]bool
	Text   string
	// Noise includes the console's own polling lines, which are otherwise
	// dropped -- and not counted.
	Noise bool
	Limit int
}

// Run reads the window from every source, merges by time, applies the
// filters and returns the newest Limit lines with counts over everything
// that matched. Counting the whole window while returning its tail is
// what lets the page say "1,204 lines from the model, showing the last
// 5,000" honestly.
func (j *Journal) Run(ctx context.Context, q Query) api.LogsQuery {
	// The readers are stopped, not just ignored, once the cap is reached:
	// journalctl would otherwise go on formatting the rest of the week.
	ctx, stop := context.WithCancel(ctx)
	defer stop()
	var (
		mu      sync.Mutex
		matched []api.JournalLine
		scanned int
		hitCap  bool
		reached float64
		byLevel = map[string]int{"error": 0, "warn": 0, "info": 0}
		byUnit  = map[string]int{}
	)
	// Counted per raw line, before the parser drops anything, so the cap
	// bounds the time spent and not the lines that survived.
	count := func() bool {
		mu.Lock()
		defer mu.Unlock()
		scanned++
		if scanned > scanCap {
			if !hitCap {
				hitCap = true
				stop()
			}
			return false
		}
		return true
	}
	keep := func(line api.JournalLine) {
		mu.Lock()
		defer mu.Unlock()
		// Newest first, so the oldest line seen is how far back the read got.
		if reached == 0 || line.T < reached {
			reached = line.T
		}
		if line.Noise && !q.Noise {
			return
		}
		if q.Text != "" && !strings.Contains(strings.ToLower(line.Text), q.Text) {
			return
		}
		// Each count leaves its own filter out: the source list says what
		// every source would contribute under the other filters, so picking
		// one source does not zero the rest, and the level chips likewise.
		unitOK := len(q.Units) == 0 || q.Units[line.Unit]
		levelOK := len(q.Levels) == 0 || q.Levels[line.Level]
		if levelOK {
			byUnit[line.Unit]++
		}
		if unitOK {
			byLevel[line.Level]++
		}
		if unitOK && levelOK {
			matched = append(matched, line)
		}
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		readJournalWindow(ctx, q.Since, q.Until, q.Text, count, keep)
	}()
	// Every container is read even when one is selected: the others'
	// counts are still wanted.
	for _, name := range containers(ctx) {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			readContainerWindow(ctx, name, q.Since, q.Until, count, keep)
		}(name)
	}
	wg.Wait()

	sort.SliceStable(matched, func(a, b int) bool { return matched[a].T < matched[b].T })
	limit := q.Limit
	if limit <= 0 || limit > len(matched) {
		limit = len(matched)
	}
	out := api.LogsQuery{
		Lines:     matched[len(matched)-limit:],
		Total:     len(matched),
		Truncated: len(matched) > limit,
		Scanned:   scanned,
		ScanCap:   hitCap,
		ByLevel:   byLevel,
		ByUnit:    byUnit,
		Since:     float64(q.Since.UnixNano()) / 1e9,
		Until:     float64(q.Until.UnixNano()) / 1e9,
	}
	if hitCap && reached > 0 {
		out.Reached = &reached
	}
	if out.Lines == nil {
		out.Lines = []api.JournalLine{}
	}
	return out
}

// readJournalWindow hands the window to journalctl newest first, with only
// the fields the parser reads -- formatting every field of every entry is
// most of what made a week take forty seconds -- and with the text search
// done by journalctl's own grep, which reads the journal without producing
// the lines that do not match.
func readJournalWindow(ctx context.Context, since, until time.Time, text string, count func() bool, keep func(api.JournalLine)) {
	if _, err := exec.LookPath("journalctl"); err != nil {
		return
	}
	args := []string{"--user", "-o", "json", "--no-pager", "--reverse",
		"--output-fields=MESSAGE,PRIORITY,_SYSTEMD_USER_UNIT,UNIT,SYSLOG_IDENTIFIER",
		"--since", "@" + strconv.FormatInt(since.Unix(), 10),
		"--until", "@" + strconv.FormatInt(until.Unix(), 10)}
	if text != "" {
		args = append(args, "--case-sensitive=false", "-g", regexp.QuoteMeta(text))
	}
	for _, unit := range unitOrder {
		args = append(args, "-u", unit)
	}
	// Matches on a second field are ANDed with the unit matches, and
	// within the field ORed: only what the units' own processes wrote.
	// Without this, journalctl formats every line xpu-smi ever logged
	// from inside the console's cgroup -- 94% of the journal here -- and a
	// week takes forty seconds instead of one.
	for _, id := range identifiers(ctx) {
		args = append(args, "SYSLOG_IDENTIFIER="+id)
	}
	cmd := exec.CommandContext(ctx, "journalctl", args...)
	out, err := cmd.StdoutPipe()
	if err != nil || cmd.Start() != nil {
		return
	}
	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		if !count() {
			break
		}
		if line, _, ok := parseJournalEntry(sc.Bytes()); ok {
			keep(line)
		}
	}
	cmd.Wait()
}

// identifiers is what journald tags each followed unit's own output with:
// the basename of the program the unit runs, plus systemd for init.scope.
// Derived from the units rather than written down, so a renamed binary is
// still found; a child that logs under another name is not the unit's log.
var (
	identMu sync.Mutex
	identAt time.Time
	idents  []string
)

func identifiers(ctx context.Context) []string {
	identMu.Lock()
	defer identMu.Unlock()
	if time.Since(identAt) < 5*time.Minute && len(idents) > 0 {
		return idents
	}
	seen := map[string]bool{"systemd": true}
	out := []string{"systemd"}
	args := append([]string{"--user", "show", "-p", "ExecStart"}, unitOrder...)
	if raw, err := exec.CommandContext(ctx, "systemctl", args...).Output(); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			// ExecStart={ path=/home/x/ai/console/tenkstack ; argv[]=... }
			_, rest, ok := strings.Cut(line, "path=")
			if !ok {
				continue
			}
			path := strings.TrimSpace(strings.SplitN(rest, ";", 2)[0])
			if i := strings.LastIndex(path, "/"); i >= 0 {
				path = path[i+1:]
			}
			if path != "" && !seen[path] {
				seen[path] = true
				out = append(out, path)
			}
		}
	}
	idents, identAt = out, time.Now()
	return out
}

func readContainerWindow(ctx context.Context, name string, since, until time.Time, count func() bool, keep func(api.JournalLine)) {
	cmd := exec.CommandContext(ctx, "docker", "logs", "--timestamps",
		"--since", since.UTC().Format(time.RFC3339), "--until", until.UTC().Format(time.RFC3339), name)
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
		if !count() {
			break
		}
		if line, ok := parseContainerLine(name, sc.Text()); ok {
			keep(line)
		}
	}
	cmd.Wait()
}

// The console's own heartbeat against llama-swap and Caddy: a request every
// few seconds from loopback that says nothing about anybody's work. Flagged
// rather than dropped, so the page can show them on request and the follower
// does not have to decide.
var polling = regexp.MustCompile(`127\.0\.0\.1 "GET /(running|v1/models|health|api/health)[ ?"]`)

func isNoise(text string) bool {
	return polling.MatchString(text)
}

// Sources is every place a line can come from and whether it is being
// read: the units the follower asks journalctl for, with what systemd says
// about them, and the containers, with what docker says. A unit that does
// not exist on this machine is listed as absent rather than left out,
// because the difference between "nothing happened" and "nobody is
// listening" is the whole point of the list.
func (j *Journal) Sources(ctx context.Context) api.LogSources {
	j.mu.Lock()
	buffered := map[string]int{}
	last := map[string]float64{}
	for _, line := range j.lines {
		buffered[line.Unit]++
		last[line.Unit] = line.T
	}
	following := map[string]bool{}
	for name, on := range j.followed {
		following[name] = on
	}
	journalUp := j.journalUp
	j.mu.Unlock()

	var out api.LogSources
	states := unitStates(ctx, unitOrder)
	for _, unit := range unitOrder {
		st := states[unit]
		// Two names for one console; only the one this machine runs is a
		// source, the other would sit there as absent forever.
		if st.load != "loaded" && (unit == "tenkstack-console.service" || unit == "ai-console.service") {
			continue
		}
		src := api.LogSource{Unit: unit, Label: Units[unit], Kind: "unit",
			Present: st.load == "loaded", State: st.active, Following: journalUp && st.load == "loaded",
			Buffered: buffered[unit]}
		if unit == "init.scope" {
			src.Present, src.State, src.Following = true, "active", journalUp
		}
		if t, ok := last[unit]; ok {
			src.LastT = &t
		}
		out.Sources = append(out.Sources, src)
	}
	for _, c := range containerStates(ctx) {
		src := api.LogSource{Unit: c.name, Label: comfyLabel, Kind: "container",
			Present: true, State: c.state, Following: following[c.name], Buffered: buffered[c.name]}
		if t, ok := last[c.name]; ok {
			src.LastT = &t
		}
		out.Sources = append(out.Sources, src)
	}
	if out.Sources == nil {
		out.Sources = []api.LogSource{}
	}
	out.Journal = journalRetention(ctx)
	return out
}

type unitState struct{ load, active string }

func unitStates(ctx context.Context, units []string) map[string]unitState {
	out := map[string]unitState{}
	args := append([]string{"--user", "show", "-p", "Id,LoadState,ActiveState"}, units...)
	raw, err := exec.CommandContext(ctx, "systemctl", args...).Output()
	if err != nil {
		return out
	}
	var cur unitState
	var id string
	flush := func() {
		if id != "" {
			out[id] = cur
		}
		id, cur = "", unitState{}
	}
	for _, line := range strings.Split(string(raw), "\n") {
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			flush()
			continue
		}
		switch key {
		case "Id":
			id = val
		case "LoadState":
			cur.load = val
		case "ActiveState":
			cur.active = val
		}
	}
	flush()
	return out
}

type containerState struct{ name, state string }

func containerStates(ctx context.Context) []containerState {
	raw, err := exec.CommandContext(ctx, "docker", "ps", "-a", "--format", "{{.Names}}\t{{.State}}", "--filter", "name="+comfyPrefix).Output()
	if err != nil {
		return nil
	}
	var out []containerState
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		name, state, ok := strings.Cut(line, "\t")
		if ok && name != "" {
			out = append(out, containerState{name, state})
		}
	}
	return out
}

// journalRetention is how far back the journal goes and what it weighs,
// cached because the oldest entry means reading the first file and this is
// asked on every page open.
var (
	retentionMu sync.Mutex
	retentionAt time.Time
	retention   api.JournalRetention
)

func journalRetention(ctx context.Context) api.JournalRetention {
	retentionMu.Lock()
	defer retentionMu.Unlock()
	if time.Since(retentionAt) < 5*time.Minute {
		return retention
	}
	var out api.JournalRetention
	if _, err := exec.LookPath("journalctl"); err != nil {
		retention, retentionAt = out, time.Now()
		return out
	}
	out.Available = true
	if raw, err := exec.CommandContext(ctx, "journalctl", "--user", "--disk-usage").Output(); err == nil {
		// "Archived and active journals take up 525.7M in the file system."
		fields := strings.Fields(string(raw))
		for i, f := range fields {
			if f == "up" && i+1 < len(fields) {
				out.DiskUsage = fields[i+1]
			}
		}
	}
	if raw, err := exec.CommandContext(ctx, "journalctl", "--user", "-o", "short-unix", "--no-pager", "-n", "1", "--reverse").Output(); err == nil {
		out.Newest = firstStamp(string(raw))
	}
	// The oldest line is the first one out; head the stream rather than
	// reading it all. A pipe closed after one line ends journalctl with
	// SIGPIPE, which is the intended way to stop it.
	cmd := exec.CommandContext(ctx, "journalctl", "--user", "-o", "short-unix", "--no-pager")
	if pipe, err := cmd.StdoutPipe(); err == nil && cmd.Start() == nil {
		sc := bufio.NewScanner(pipe)
		if sc.Scan() {
			out.Oldest = firstStamp(sc.Text())
		}
		pipe.Close()
		cmd.Wait()
	}
	out.Persistent = persistentJournal()
	retention, retentionAt = out, time.Now()
	return out
}

func firstStamp(line string) *float64 {
	f := strings.Fields(line)
	if len(f) == 0 {
		return nil
	}
	v, err := strconv.ParseFloat(f[0], 64)
	if err != nil {
		return nil
	}
	return &v
}

// persistentJournal: a journal that survives a reboot lives under
// /var/log/journal; one under /run is gone with it.
func persistentJournal() bool {
	raw, err := exec.Command("journalctl", "--user", "--header").Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(raw), "/var/log/journal")
}
