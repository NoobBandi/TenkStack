// Package release asks GitHub for the newest TenkStack release and, on
// request, replaces the running binary with it. Every installation checks
// for itself -- there is no server of ours in the loop -- and an
// installation with no route out simply reports that it could not ask.
package release

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
)

// The default repository, and how often it is asked. GitHub allows sixty
// unauthenticated requests an hour per address; one every six hours is
// nothing, and a person can always press the button.
const (
	DefaultRepo = "NoobBandi/TenkStack"
	DefaultAPI  = "https://api.github.com"
	recheck     = 6 * time.Hour
)

// Client holds the last answer and knows how to act on it.
type Client struct {
	Repo    string
	API     string
	Current string
	// Units are the user units the console may be running as; the one
	// that is active is restarted after a swap.
	Units []string

	mu     sync.Mutex
	cached api.Release
	at     time.Time
}

func New(repo, apiBase, current string, units []string) *Client {
	if repo == "" {
		repo = DefaultRepo
	}
	if apiBase == "" {
		apiBase = DefaultAPI
	}
	return &Client{Repo: repo, API: strings.TrimRight(apiBase, "/"), Current: current, Units: units}
}

// AssetName is what the release workflow calls the binary for this machine.
func AssetName() string {
	return "tenkstack-linux-" + runtime.GOARCH
}

type ghRelease struct {
	TagName     string `json:"tag_name"`
	Name        string `json:"name"`
	Body        string `json:"body"`
	HTMLURL     string `json:"html_url"`
	PublishedAt string `json:"published_at"`
	Draft       bool   `json:"draft"`
	Prerelease  bool   `json:"prerelease"`
	Assets      []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
		Size int64  `json:"size"`
	} `json:"assets"`
}

// Latest is the newest release, from the cache unless it is stale or
// force is set. A failed ask is cached too, for a shorter while, with its
// reason -- so a machine with no route out does not retry on every page.
func (c *Client) Latest(ctx context.Context, force bool) api.Release {
	c.mu.Lock()
	fresh := !c.at.IsZero() && time.Since(c.at) < recheck
	if c.cached.Error != "" {
		fresh = !c.at.IsZero() && time.Since(c.at) < 15*time.Minute
	}
	if fresh && !force {
		out := c.cached
		c.mu.Unlock()
		return out
	}
	c.mu.Unlock()

	out := c.fetch(ctx)
	c.mu.Lock()
	c.cached, c.at = out, time.Now()
	c.mu.Unlock()
	return out
}

func (c *Client) fetch(ctx context.Context) api.Release {
	now := float64(time.Now().UnixNano()) / 1e9
	out := api.Release{Current: c.Current, Repo: c.Repo, Arch: runtime.GOARCH, CheckedAt: &now, Assets: []api.ReleaseAsset{}}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.API+"/repos/"+c.Repo+"/releases/latest", nil)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "TenkStack/"+c.Current)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		out.Error = "連不上 GitHub：" + err.Error()
		return out
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == 404:
		out.Error = "GitHub 上查不到 release（倉庫還是私有的，或還沒發布過）"
		return out
	case resp.StatusCode == 403 || resp.StatusCode == 429:
		out.Error = "GitHub 暫時不讓查（匿名查詢每小時有上限），晚點再試"
		return out
	case resp.StatusCode != 200:
		out.Error = fmt.Sprintf("GitHub 回了 %d", resp.StatusCode)
		return out
	}
	var rel ghRelease
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&rel); err != nil {
		out.Error = "看不懂 GitHub 的回應：" + err.Error()
		return out
	}
	latest := strings.TrimPrefix(rel.TagName, "v")
	out.Latest = &latest
	out.Name = rel.Name
	out.Body = rel.Body
	out.URL = rel.HTMLURL
	if t, err := time.Parse(time.RFC3339, rel.PublishedAt); err == nil {
		at := float64(t.UnixNano()) / 1e9
		out.PublishedAt = &at
	}
	for _, a := range rel.Assets {
		out.Assets = append(out.Assets, api.ReleaseAsset{Name: a.Name, URL: a.URL, Size: a.Size})
	}
	if out.Assets == nil {
		out.Assets = []api.ReleaseAsset{}
	}
	out.Newer = Newer(latest, c.Current)
	out.CanApply, out.ApplyNote = c.canApply(out)
	return out
}

// canApply is whether this process could replace itself with the release:
// the release carries a binary for this architecture and a checksum for
// it, and the file this process runs from can be written.
func (c *Client) canApply(rel api.Release) (bool, string) {
	if rel.Latest == nil {
		return false, ""
	}
	var binary, sums bool
	for _, a := range rel.Assets {
		if a.Name == AssetName() {
			binary = true
		}
		if a.Name == "SHA256SUMS" {
			sums = true
		}
	}
	if !binary {
		return false, "這個 release 沒有 " + AssetName() + " 可以下載"
	}
	if !sums {
		return false, "這個 release 沒有 SHA256SUMS，不敢換"
	}
	exe, err := executable()
	if err != nil {
		return false, "找不到現在跑的是哪個檔案：" + err.Error()
	}
	if f, err := os.OpenFile(filepath.Dir(exe)+"/.tenkstack-write-test", os.O_CREATE|os.O_WRONLY, 0o644); err != nil {
		return false, "主控台所在的目錄寫不進去（" + filepath.Dir(exe) + "）"
	} else {
		f.Close()
		os.Remove(f.Name())
	}
	if c.activeUnit(context.Background()) == "" {
		return true, "換好之後要自己重啟主控台：它不是 systemd 在跑"
	}
	return true, ""
}

func executable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}

// activeUnit is the user unit this console is running as, if any.
func (c *Client) activeUnit(ctx context.Context) string {
	for _, unit := range c.Units {
		out, err := exec.CommandContext(ctx, "systemctl", "--user", "is-active", unit).Output()
		if err == nil && strings.TrimSpace(string(out)) == "active" {
			return unit
		}
	}
	return ""
}

// Apply downloads the release's binary for this machine, checks it
// against the release's own checksum, swaps it in under the running
// process -- which keeps its old inode until it exits -- and then
// restarts the unit. The old binary stays beside the new one as
// tenkstack.prev, so a release that will not start can be put back by
// hand.
func (c *Client) Apply(ctx context.Context) (api.ReleaseApply, error) {
	rel := c.Latest(ctx, false)
	if rel.Latest == nil {
		return api.ReleaseApply{}, errors.New(orElse(rel.Error, "還沒查到 release"))
	}
	if !rel.Newer {
		return api.ReleaseApply{}, errors.New("已經是最新的 v" + c.Current)
	}
	if !rel.CanApply {
		return api.ReleaseApply{}, errors.New(orElse(rel.ApplyNote, "這台沒辦法自己換"))
	}
	var binURL, sumsURL string
	for _, a := range rel.Assets {
		switch a.Name {
		case AssetName():
			binURL = a.URL
		case "SHA256SUMS":
			sumsURL = a.URL
		}
	}
	exe, err := executable()
	if err != nil {
		return api.ReleaseApply{}, err
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	sums, err := fetchAll(ctx, sumsURL, 1<<20)
	if err != nil {
		return api.ReleaseApply{}, fmt.Errorf("下載 SHA256SUMS 失敗：%w", err)
	}
	want := ""
	for _, line := range strings.Split(string(sums), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == AssetName() {
			want = strings.ToLower(f[0])
		}
	}
	if want == "" {
		return api.ReleaseApply{}, errors.New("SHA256SUMS 裡沒有 " + AssetName())
	}

	tmp := exe + ".new"
	if err := download(ctx, binURL, tmp); err != nil {
		os.Remove(tmp)
		return api.ReleaseApply{}, fmt.Errorf("下載 %s 失敗：%w", AssetName(), err)
	}
	got, err := fileSHA256(tmp)
	if err != nil || got != want {
		os.Remove(tmp)
		return api.ReleaseApply{}, fmt.Errorf("下載的檔案校驗不符（%s ≠ %s），沒有換", short(got), short(want))
	}
	if err := os.Chmod(tmp, 0o755); err != nil {
		os.Remove(tmp)
		return api.ReleaseApply{}, err
	}
	// Two renames: the running file becomes .prev, the new one takes its
	// name. The process keeps running on the old inode either way.
	os.Remove(exe + ".prev")
	if err := os.Rename(exe, exe+".prev"); err != nil {
		os.Remove(tmp)
		return api.ReleaseApply{}, fmt.Errorf("搬不開現在的檔案：%w", err)
	}
	if err := os.Rename(tmp, exe); err != nil {
		os.Rename(exe+".prev", exe)
		os.Remove(tmp)
		return api.ReleaseApply{}, fmt.Errorf("放不進新的檔案：%w", err)
	}
	log.Printf("replaced %s with release v%s (%s)", exe, *rel.Latest, short(got))

	out := api.ReleaseApply{OK: true, Version: *rel.Latest, Path: exe}
	if unit := c.activeUnit(ctx); unit != "" {
		out.Restarting, out.Unit = true, unit
		// After the response has gone out. The restart ends this process.
		go func() {
			time.Sleep(700 * time.Millisecond)
			log.Printf("restarting %s for release v%s", unit, *rel.Latest)
			if err := exec.Command("systemctl", "--user", "restart", unit).Run(); err != nil {
				log.Printf("could not restart %s: %v", unit, err)
			}
		}()
	} else {
		out.Detail = "檔案換好了；主控台不是 systemd 在跑，請自己重啟"
	}
	return out, nil
}

func orElse(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func short(sum string) string {
	if len(sum) > 12 {
		return sum[:12]
	}
	return sum
}

func fetchAll(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

func download(ctx context.Context, url, path string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Newer is whether a is a later version than b, read as dotted numbers
// with anything after a hyphen counting as earlier than the bare number.
func Newer(a, b string) bool {
	return compare(a, b) > 0
}

func compare(a, b string) int {
	an, apre := split(a)
	bn, bpre := split(b)
	for i := 0; i < 3; i++ {
		if an[i] != bn[i] {
			if an[i] > bn[i] {
				return 1
			}
			return -1
		}
	}
	switch {
	case apre == "" && bpre != "":
		return 1
	case apre != "" && bpre == "":
		return -1
	}
	return strings.Compare(apre, bpre)
}

func split(v string) ([3]int, string) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	pre := ""
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		pre = v[i+1:]
		v = v[:i]
	}
	var out [3]int
	for i, part := range strings.SplitN(v, ".", 3) {
		n, _ := strconv.Atoi(strings.TrimFunc(part, func(r rune) bool { return r < '0' || r > '9' }))
		out[i] = n
	}
	return out, pre
}
