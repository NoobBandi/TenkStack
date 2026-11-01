// Package sandbox runs the agent's Python on this machine, one container
// per conversation, under gVisor.
//
// The containers package refuses to create or exec into containers, because
// the console's user is in the docker group and those verbs, taking
// arguments from a request, would be a root shell. This package does both,
// and the argument against that holds only because nothing in the command
// line comes from a request: the image is the one built here from the files
// beside this one, the runtime is always runsc, there are no mounts and no
// network, and the code a model wrote travels on stdin to a process inside
// the container, never into docker's arguments.
//
// gVisor is the boundary, not Docker. Its sentry implements the system calls
// itself, so code that finds a kernel bug finds one in gVisor rather than in
// the host's kernel, which also holds the GPUs and every model. Without runsc
// nothing runs here at all; the plain runtime is not offered as a fallback.
package sandbox

import (
	"bytes"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/NoobBandi/TenkStack/internal/api"
)

//go:embed image
var recipe embed.FS

const (
	// Repo is the image's name; the tag is the recipe's hash.
	Repo = "tenkstack/sandbox"
	// label marks the containers this package owns, so they can be found
	// again after the console restarts and removed all at once.
	label        = "tenkstack.sandbox"
	labelOwner   = "tenkstack.sandbox.owner"
	labelSession = "tenkstack.sandbox.session"
	namePrefix   = "tenkstack-sandbox-"
	// MaxBoxes is how many conversations may hold a container at once.
	// Each holds up to its memory limit; past this the least recently used
	// idle one is removed to make room.
	MaxBoxes = 6
	// Idle is how long a container is kept without a call. Its namespace is
	// the whole point of keeping it, and a conversation left for this long
	// is usually over.
	Idle = 20 * time.Minute
	// Grace is how long an interrupted call has to come back before its
	// container is removed. SIGINT stops Python between bytecodes; a call
	// stuck inside one C function never sees it.
	Grace = 10 * time.Second
	// MaxOutput is what the model gets of each stream, the same as the
	// browser's Python: a print in a loop can produce megabytes, and the
	// context window is the scarce thing.
	MaxOutput = 8000
	// MaxFile is the largest file offered for download.
	MaxFile = 50 << 20

	cpus = "2"
	pids = "512"
	home = "/home/sandbox"
)

// Invalid is a request that cannot be carried out, worth a 400; Unavailable
// is a sandbox that is not set up here, worth a 503; Busy is every slot
// taken by a call that is running, worth a 429.
type (
	Invalid     struct{ Msg string }
	Unavailable struct{ Msg string }
	Busy        struct{ Msg string }
)

func (e *Invalid) Error() string     { return e.Msg }
func (e *Unavailable) Error() string { return e.Msg }
func (e *Busy) Error() string        { return e.Msg }

// ErrNotFound is a file that is not in the working directory, or a
// conversation that has no container any more.
var ErrNotFound = errors.New("not found")

// Manager owns the image and the containers.
type Manager struct {
	// Dir is where the build context is written.
	Dir string
	// Limits reads the settings at the moment they are needed, so a change
	// applies to the next call (timeout) or the next container (memory).
	Limits func() (timeout time.Duration, memoryGiB int64)

	mu    sync.Mutex
	boxes map[string]*box
	// build is the background build, when there is or was one.
	building bool
	buildErr string
	// runtime caches whether runsc is registered: `docker info` is slow
	// enough to matter on a status poll.
	runtime   bool
	runtimeAt time.Time
}

// box is one conversation's container.
type box struct {
	name    string
	owner   int64
	session string
	// calls is how many have run in this container's lifetime, or before
	// it for an adopted one. A container started when calls is above zero
	// is a reset: what the earlier calls defined is gone.
	calls int
	used  time.Time
	busy  bool
	// run holds a call: one at a time per conversation, since they share a
	// namespace.
	run sync.Mutex
}

func New(dir string, limits func() (time.Duration, int64)) *Manager {
	return &Manager{Dir: dir, Limits: limits, boxes: map[string]*box{}}
}

var sessionPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// ValidSession is the shape the browser makes session ids in.
func ValidSession(s string) bool { return sessionPattern.MatchString(s) }

// containerName is per owner and session, hashed so a session id never
// reaches docker's arguments as itself.
func containerName(owner int64, session string) string {
	sum := sha256.Sum256([]byte(session))
	return fmt.Sprintf("%su%d-%s", namePrefix, owner, hex.EncodeToString(sum[:])[:12])
}

// Tag is the image the recipe here builds: a hash of every file in it.
func Tag() string {
	h := sha256.New()
	var names []string
	_ = fs.WalkDir(recipe, "image", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			names = append(names, p)
		}
		return nil
	})
	sort.Strings(names)
	for _, n := range names {
		data, _ := recipe.ReadFile(n)
		fmt.Fprintf(h, "%s\x00%d\x00", n, len(data))
		h.Write(data)
	}
	return Repo + ":" + hex.EncodeToString(h.Sum(nil))[:12]
}

// maxExec bounds what one docker command may print back. The code in a
// container runs as the same user as client.py and can write to its
// output, so without a bound a call could fill the console's memory.
// A file read is at most 50 MB; a run's reply is far less.
const maxExec = 64 << 20

// capped keeps the first max bytes and drops the rest, so an oversized reply
// fails to parse instead of being held.
type capped struct {
	bytes.Buffer
	max int
}

func (c *capped) Write(p []byte) (int, error) {
	if room := c.max - c.Len(); room > 0 {
		c.Buffer.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

func docker(ctx context.Context, stdin io.Reader, args ...string) ([]byte, string, error) {
	cmd := exec.CommandContext(ctx, "docker", args...)
	stdout, stderr := &capped{max: maxExec}, &capped{max: 1 << 20}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdin, stdout, stderr
	err := cmd.Run()
	return stdout.Bytes(), strings.TrimSpace(stderr.String()), err
}

// hasRuntime is whether Docker knows runsc.
func (m *Manager) hasRuntime(ctx context.Context) bool {
	m.mu.Lock()
	if time.Since(m.runtimeAt) < 30*time.Second {
		ok := m.runtime
		m.mu.Unlock()
		return ok
	}
	m.mu.Unlock()
	out, _, err := docker(ctx, nil, "info", "--format", "{{json .Runtimes}}")
	ok := err == nil && bytes.Contains(out, []byte(`"runsc"`))
	m.mu.Lock()
	m.runtime, m.runtimeAt = ok, time.Now()
	m.mu.Unlock()
	return ok
}

// images is every build of the sandbox here, newest first.
func images(ctx context.Context) []string {
	out, _, err := docker(ctx, nil, "images", Repo, "--format", "{{.Repository}}:{{.Tag}}")
	if err != nil {
		return nil
	}
	var refs []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line = strings.TrimSpace(line); line != "" && !strings.HasSuffix(line, ":<none>") {
			refs = append(refs, line)
		}
	}
	return refs
}

// image is the build new containers start from, and what state that
// leaves the sandbox in: the current recipe's when it is here, else the
// newest older one, which still works until it is rebuilt.
func (m *Manager) image(ctx context.Context) (ref, state string) {
	current := Tag()
	refs := images(ctx)
	for _, r := range refs {
		if r == current {
			return r, "ready"
		}
	}
	if len(refs) > 0 {
		return refs[0], "outdated"
	}
	return "", "absent"
}

func (m *Manager) Status(ctx context.Context) api.SandboxStatus {
	timeout, memory := m.Limits()
	out := api.SandboxStatus{
		Runtime:   m.hasRuntime(ctx),
		TimeoutS:  int64(timeout / time.Second),
		MemoryGiB: memory,
		IdleMin:   int(Idle / time.Minute),
	}
	ref, state := m.image(ctx)
	out.Image, out.State = ref, state
	m.mu.Lock()
	switch {
	case m.building:
		out.State = "building"
	case m.buildErr != "" && state != "ready":
		out.State, out.Message = "error", m.buildErr
	}
	out.Sessions = len(m.boxes)
	m.mu.Unlock()
	out.Ready = out.Runtime && ref != ""
	return out
}

// Build makes the current recipe's image in the background. Older builds
// are removed once it succeeds; a container still using one keeps it until
// that container goes.
func (m *Manager) Build(ctx context.Context) (api.SandboxStatus, error) {
	if !m.hasRuntime(ctx) {
		return m.Status(ctx), &Unavailable{"這台機器的 Docker 沒有 gVisor（runsc），沙箱建立不了"}
	}
	m.mu.Lock()
	if m.building {
		m.mu.Unlock()
		return m.Status(ctx), nil
	}
	m.building, m.buildErr = true, ""
	m.mu.Unlock()

	dir := filepath.Join(m.Dir, "build")
	if err := m.writeRecipe(dir); err != nil {
		m.mu.Lock()
		m.building, m.buildErr = false, err.Error()
		m.mu.Unlock()
		return m.Status(ctx), err
	}
	tag := Tag()
	go func() {
		// Not the request's context: the build outlives the request that
		// asked for it by several minutes.
		bctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		_, stderr, err := docker(bctx, nil, "build", "--pull", "-t", tag, dir)
		m.mu.Lock()
		m.building = false
		if err != nil {
			tail := stderr
			if len(tail) > 2000 {
				tail = tail[len(tail)-2000:]
			}
			m.buildErr = strings.TrimSpace(tail)
			m.mu.Unlock()
			log.Printf("sandbox: could not build %s: %v", tag, err)
			return
		}
		m.mu.Unlock()
		log.Printf("sandbox: built %s", tag)
		for _, old := range images(bctx) {
			if old != tag {
				// Refused while a container still runs it, which is fine:
				// the next build or removal gets it.
				_, _, _ = docker(bctx, nil, "rmi", old)
			}
		}
	}()
	return m.Status(ctx), nil
}

func (m *Manager) writeRecipe(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return fs.WalkDir(recipe, "image", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := recipe.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(dir, strings.TrimPrefix(p, "image/")), data, 0o644)
	})
}

// Remove takes the sandbox off this machine: every container, then every
// image. The chat falls back to the browser's Python.
func (m *Manager) Remove(ctx context.Context) api.SandboxStatus {
	m.mu.Lock()
	m.boxes = map[string]*box{}
	m.buildErr = ""
	m.mu.Unlock()
	for _, name := range m.listed(ctx) {
		_, _, _ = docker(ctx, nil, "rm", "-f", name)
	}
	for _, ref := range images(ctx) {
		_, _, _ = docker(ctx, nil, "rmi", ref)
	}
	return m.Status(ctx)
}

// listed is every sandbox container docker has, running or not.
func (m *Manager) listed(ctx context.Context) []string {
	out, _, err := docker(ctx, nil, "ps", "-a", "--filter", "label="+label, "--format", "{{.Names}}")
	if err != nil {
		return nil
	}
	return strings.Fields(string(out))
}

// Adopt takes back the containers a previous console process left
// running, so a restart of the console does not cost a conversation its
// namespace. Their calls are unknown and counted as one: should one turn
// out to be gone, its next start is reported as a reset.
func (m *Manager) Adopt(ctx context.Context) {
	out, _, err := docker(ctx, nil, "ps", "--filter", "label="+label, "--format",
		`{{.Names}}	{{.Label "`+labelOwner+`"}}	{{.Label "`+labelSession+`"}}`)
	if err != nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.Split(line, "\t")
		if len(parts) != 3 || !strings.HasPrefix(parts[0], namePrefix) {
			continue
		}
		owner, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || containerName(owner, parts[2]) != parts[0] {
			continue
		}
		m.boxes[parts[0]] = &box{name: parts[0], owner: owner, session: parts[2], calls: 1, used: time.Now()}
	}
}

// Watch removes containers left idle, until ctx ends.
func (m *Manager) Watch(ctx context.Context) {
	m.Adopt(ctx)
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			m.reap(ctx, time.Now().Add(-Idle))
		}
	}
}

func (m *Manager) reap(ctx context.Context, before time.Time) {
	m.mu.Lock()
	var gone []string
	for name, b := range m.boxes {
		if !b.busy && b.used.Before(before) {
			gone = append(gone, name)
			delete(m.boxes, name)
		}
	}
	m.mu.Unlock()
	for _, name := range gone {
		_, _, _ = docker(ctx, nil, "rm", "-f", name)
	}
	// A container nobody has a box for -- left by a run that crashed the
	// console -- is not anyone's conversation any more.
	m.mu.Lock()
	known := map[string]bool{}
	for name := range m.boxes {
		known[name] = true
	}
	m.mu.Unlock()
	for _, name := range m.listed(ctx) {
		if !known[name] {
			_, _, _ = docker(ctx, nil, "rm", "-f", name)
		}
	}
}

// claim is the conversation's box, made if it has none, with room made
// for it if every slot is taken.
func (m *Manager) claim(ctx context.Context, owner int64, session string) (*box, error) {
	name := containerName(owner, session)
	m.mu.Lock()
	b, ok := m.boxes[name]
	var evict string
	if !ok {
		if len(m.boxes) >= MaxBoxes {
			var oldest *box
			for _, other := range m.boxes {
				if !other.busy && (oldest == nil || other.used.Before(oldest.used)) {
					oldest = other
				}
			}
			if oldest == nil {
				m.mu.Unlock()
				return nil, &Busy{fmt.Sprintf("同時在跑的 Python 沙箱已經有 %d 個，請稍後再試", MaxBoxes)}
			}
			delete(m.boxes, oldest.name)
			evict = oldest.name
		}
		b = &box{name: name, owner: owner, session: session, used: time.Now()}
		m.boxes[name] = b
	}
	m.mu.Unlock()
	if evict != "" {
		_, _, _ = docker(ctx, nil, "rm", "-f", evict)
	}
	return b, nil
}

func (m *Manager) setBusy(b *box, busy bool) {
	m.mu.Lock()
	b.busy, b.used = busy, time.Now()
	m.mu.Unlock()
}

// RunArgs is the whole of what docker is told about a container. Nothing
// in it comes from a request: the name is a hash, the owner a number.
func RunArgs(name, ref string, owner int64, session string, memoryGiB int64) []string {
	mem := fmt.Sprintf("%dg", memoryGiB)
	return []string{
		"run", "-d", "--name", name,
		"--runtime=runsc", "--network=none", "--init",
		// Read-only except two tmpfs, sized: the files a call writes count
		// against the memory limit rather than against the host's disk.
		"--read-only",
		"--tmpfs", "/tmp:rw,size=256m,mode=1777",
		"--tmpfs", home + ":rw,size=" + mem + ",uid=1000,gid=1000,mode=0755",
		"--memory=" + mem, "--memory-swap=" + mem,
		"--cpus=" + cpus, "--pids-limit=" + pids,
		"--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=1000:1000",
		"--label", label + "=1",
		"--label", labelOwner + "=" + strconv.FormatInt(owner, 10),
		"--label", labelSession + "=" + session,
		ref,
	}
}

// running is whether the container is up, and whether the kernel in it
// was killed for memory when it is not.
func running(ctx context.Context, name string) (up, oom, exists bool) {
	out, _, err := docker(ctx, nil, "inspect", "--format", "{{.State.Running}} {{.State.OOMKilled}}", name)
	if err != nil {
		return false, false, false
	}
	f := strings.Fields(string(out))
	return len(f) == 2 && f[0] == "true", len(f) == 2 && f[1] == "true", true
}

// ensure starts the box's container if it is not running. started says it
// had to, which after earlier calls is a reset.
func (m *Manager) ensure(ctx context.Context, b *box) (started bool, err error) {
	if up, _, exists := running(ctx, b.name); up {
		return false, nil
	} else if exists {
		_, _, _ = docker(ctx, nil, "rm", "-f", b.name)
	}
	ref, _ := m.image(ctx)
	if ref == "" {
		return false, &Unavailable{"Python 沙箱還沒建立，請管理員到設定頁建立"}
	}
	_, memory := m.Limits()
	if _, stderr, err := docker(ctx, nil, RunArgs(b.name, ref, b.owner, b.session, memory)...); err != nil {
		return false, fmt.Errorf("沙箱啟動失敗：%s", stderr)
	}
	// The kernel imports matplotlib before it listens, a second or two.
	deadline := time.Now().Add(45 * time.Second)
	for time.Now().Before(deadline) {
		if out, _, err := docker(ctx, nil, "exec", b.name, "python", "/opt/kernel/client.py", "ping"); err == nil && bytes.Contains(out, []byte(`"ok"`)) {
			return true, nil
		}
		select {
		case <-ctx.Done():
			return true, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
	logs, _, _ := docker(context.Background(), nil, "logs", "--tail", "20", b.name)
	return true, fmt.Errorf("沙箱啟動後沒有回應：%s", strings.TrimSpace(string(logs)))
}

// reply is what the kernel answers a run with.
type reply struct {
	Stdout      string            `json:"stdout"`
	Stderr      string            `json:"stderr"`
	Value       *string           `json:"value"`
	Error       *string           `json:"error"`
	Interrupted bool              `json:"interrupted"`
	Images      []string          `json:"images"`
	Files       []api.SandboxFile `json:"files"`
	ElapsedMS   int64             `json:"elapsed_ms"`
	Truncated   bool              `json:"truncated"`
}

// Clip cuts text to n characters on a character boundary.
func Clip(text string, n int) (string, bool) {
	if utf8.RuneCountInString(text) <= n {
		return text, false
	}
	runes := []rune(text)
	return string(runes[:n]) + "\n…（輸出過長，已截斷）", true
}

func say(s string) *string { return &s }

// Run executes code in the conversation's namespace.
//
// The time limit is enforced from here rather than by the kernel: a SIGINT
// stops the cell and keeps everything it defined, and only a cell that does
// not stop within Grace costs the conversation its container. A request
// that goes away -- the user pressed stop -- is handled the same way.
func (m *Manager) Run(ctx context.Context, owner int64, session, code string) (api.SandboxRun, error) {
	if !ValidSession(session) {
		return api.SandboxRun{}, &Invalid{"session 格式不對"}
	}
	if !m.hasRuntime(ctx) {
		return api.SandboxRun{}, &Unavailable{"這台機器的 Docker 沒有 gVisor（runsc）"}
	}
	b, err := m.claim(ctx, owner, session)
	if err != nil {
		return api.SandboxRun{}, err
	}
	b.run.Lock()
	defer b.run.Unlock()
	m.setBusy(b, true)
	defer m.setBusy(b, false)

	started, err := m.ensure(ctx, b)
	if err != nil {
		return api.SandboxRun{}, err
	}
	out := api.SandboxRun{Images: []string{}, Files: []api.SandboxFile{}, Reset: started && b.calls > 0}
	b.calls++

	timeout, memory := m.Limits()
	body, _ := json.Marshal(map[string]string{"code": code})
	cmd := exec.Command("docker", "exec", "-i", b.name, "python", "/opt/kernel/client.py", "run")
	stdout, stderr := &capped{max: maxExec}, &capped{max: 1 << 20}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = bytes.NewReader(body), stdout, stderr
	begun := time.Now()
	if err := cmd.Start(); err != nil {
		return out, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	var waitErr error
	stopped := false
	select {
	case waitErr = <-done:
	case <-timer.C:
		stopped = true
	case <-ctx.Done():
		stopped = true
	}
	if stopped {
		ictx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, _, _ = docker(ictx, nil, "exec", b.name, "python", "/opt/kernel/client.py", "interrupt")
		cancel()
		select {
		case waitErr = <-done:
		case <-time.After(Grace):
			// It did not stop. The container goes, and the namespace with it.
			_, _, _ = docker(context.Background(), nil, "rm", "-f", b.name)
			_ = cmd.Process.Kill()
			<-done
			out.TimedOut, out.Reset = true, true
			out.ElapsedMS = time.Since(begun).Milliseconds()
			out.Error = say(fmt.Sprintf("執行超過 %d 秒，而且中斷不了，環境已經重設：之前定義的變數和檔案都不在了。", int(timeout/time.Second)))
			return out, nil
		}
	}

	var r reply
	if waitErr != nil || json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &r) != nil {
		// The kernel died mid-call. Out of memory is the usual reason, and
		// the one worth naming, since the fix is to use less of it.
		up, oom, _ := running(context.Background(), b.name)
		out.ElapsedMS = time.Since(begun).Milliseconds()
		switch {
		case oom || !up:
			_, _, _ = docker(context.Background(), nil, "rm", "-f", b.name)
			out.Reset = true
			msg := "Python 環境意外結束，已經重設：之前定義的變數和檔案都不在了。"
			if oom {
				msg = fmt.Sprintf("記憶體用完了（上限 %d GiB），程式被終止，環境已經重設：之前定義的變數和檔案都不在了。", memory)
			}
			out.Error = say(msg)
		default:
			out.Error = say("沙箱沒有正常回應：" + strings.TrimSpace(stderr.String()))
		}
		return out, nil
	}

	var cutOut, cutErr bool
	out.Stdout, cutOut = Clip(r.Stdout, MaxOutput)
	out.Stderr, cutErr = Clip(r.Stderr, MaxOutput)
	out.Truncated = r.Truncated || cutOut || cutErr
	out.Value, out.Error = r.Value, r.Error
	out.Images, out.ElapsedMS = r.Images, r.ElapsedMS
	if r.Files != nil {
		out.Files = r.Files
	}
	if out.Images == nil {
		out.Images = []string{}
	}
	if r.Interrupted {
		out.Interrupted, out.TimedOut = true, !errors.Is(ctx.Err(), context.Canceled)
		why := fmt.Sprintf("執行超過 %d 秒，已經中斷。", int(timeout/time.Second))
		if !out.TimedOut {
			why = "使用者停止了這次執行。"
		}
		out.Error = say(why + "變數和檔案都還在，可以接著用。")
	}
	return out, nil
}

// Reset removes the conversation's container; the next call starts clean.
func (m *Manager) Reset(ctx context.Context, owner int64, session string) error {
	if !ValidSession(session) {
		return &Invalid{"session 格式不對"}
	}
	name := containerName(owner, session)
	m.mu.Lock()
	delete(m.boxes, name)
	m.mu.Unlock()
	_, _, _ = docker(ctx, nil, "rm", "-f", name)
	return nil
}

// CleanPath is a path inside the working directory, relative, or "".
func CleanPath(p string) string {
	if p == "" || strings.ContainsRune(p, 0) || strings.HasPrefix(p, "/") {
		return ""
	}
	c := path.Clean(p)
	if c == "." || c == ".." || strings.HasPrefix(c, "../") {
		return ""
	}
	return c
}

// ReadFile is one file from the conversation's working directory. A
// container that is gone is not started for it: there would be nothing in
// a fresh one.
func (m *Manager) ReadFile(ctx context.Context, owner int64, session, p string) ([]byte, error) {
	clean := CleanPath(p)
	if !ValidSession(session) || clean == "" {
		return nil, &Invalid{"路徑不對"}
	}
	name := containerName(owner, session)
	if up, _, _ := running(ctx, name); !up {
		return nil, ErrNotFound
	}
	out, stderr, err := docker(ctx, nil, "exec", name, "python", "/opt/kernel/client.py", "read", clean)
	if err != nil {
		if strings.Contains(stderr, "too large") {
			return nil, &Invalid{fmt.Sprintf("檔案超過 %d MB，不提供下載", MaxFile>>20)}
		}
		return nil, ErrNotFound
	}
	m.mu.Lock()
	if b, ok := m.boxes[name]; ok {
		b.used = time.Now()
	}
	m.mu.Unlock()
	return out, nil
}
