// Package catalog searches Hugging Face and downloads GGUF files. Downloads
// are segmented because one TCP stream to the CDN could not exceed about
// 8 MiB/s here while seven reached 41; the limit is the bandwidth-delay
// product of one connection, not the server.
package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
	"github.com/NoobBandi/TenkStack/server-go/internal/locations"
)

const (
	hfAPI       = "https://huggingface.co/api"
	chunk       = 1 << 20
	segmentSize = 32 << 20 // resumable unit: little lost, negligible overhead
	parallel    = 8        // past this the gain flattens while throttling odds rise
)

// Places is where models live: every location, and which one a new
// download of a format goes to.
type Places interface {
	Locations() []locations.Location
	DefaultLocation(format string) locations.Location
}

type Catalog struct {
	Places Places
	http   *http.Client

	mu        sync.Mutex
	downloads map[string]*download
	order     []string
}

func New(places Places) *Catalog {
	return &Catalog{Places: places, http: &http.Client{Timeout: 20 * time.Second}, downloads: map[string]*download{}}
}

// safe keeps a repo or file segment usable as a directory name: traversal
// and separators out, everything else stays.
func safe(segment string) string {
	cleaned := strings.NewReplacer("/", "_", "\\", "_", "\x00", "").Replace(segment)
	cleaned = strings.Trim(cleaned, ". ")
	if cleaned == "" {
		return "_"
	}
	return cleaned
}

// LocalPath is where a repo's file lands in a location:
// <location>/<owner>/<repo>/<name>, the repo's own directories kept, since
// a filename is not an identity.
func LocalPath(loc locations.Location, repoID, filename string) string {
	return filepath.Join(loc.Path, relPath(repoID, filename))
}

// relPath is that path within the location.
func relPath(repoID, filename string) string {
	var segments []string
	for _, s := range strings.Split(repoID, "/") {
		if s != "" {
			segments = append(segments, safe(s))
		}
	}
	for _, s := range strings.Split(filepath.ToSlash(filename), "/") {
		if s != "" {
			segments = append(segments, safe(s))
		}
	}
	return filepath.Join(segments...)
}

// Search lists GGUF repos, sorted by downloads, a hundred at a time since
// the page pages through them locally.
func (c *Catalog) Search(ctx context.Context, query string, limit int) []api.CatalogRepo {
	out := []api.CatalogRepo{}
	q := url.Values{}
	q.Set("search", query)
	q.Set("filter", "gguf")
	q.Set("limit", strconv.Itoa(limit))
	q.Set("sort", "downloads")
	q.Set("direction", "-1")
	for _, f := range []string{"downloads", "likes", "tags", "lastModified"} {
		q.Add("expand[]", f)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, hfAPI+"/models?"+q.Encode(), nil)
	resp, err := c.http.Do(req)
	if err != nil {
		log.Printf("HF search failed: %v", err)
		return out
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		log.Printf("HF search failed: HTTP %d", resp.StatusCode)
		return out
	}
	var repos []map[string]any
	if json.NewDecoder(resp.Body).Decode(&repos) != nil {
		return out
	}
	for _, m := range repos {
		tags := []any{}
		if list, _ := m["tags"].([]any); list != nil {
			for _, t := range list {
				if s, _ := t.(string); strings.HasPrefix(s, "base_model") || strings.HasPrefix(s, "region") {
					continue
				}
				if len(tags) < 8 {
					tags = append(tags, t)
				}
			}
		}
		r := api.CatalogRepo{RepoID: m["id"], Downloads: m["downloads"], Likes: m["likes"], LastModified: m["lastModified"], Tags: tags}
		if r.Downloads == nil {
			r.Downloads = 0
		}
		if r.Likes == nil {
			r.Likes = 0
		}
		out = append(out, r)
	}
	return out
}

// A model too large for one file is uploaded as …-00001-of-00003.gguf.
var split = regexp.MustCompile(`(?i)^(.+)-(\d{5})-of-(\d{5})\.gguf$`)

// indexByName is every GGUF in every location by base name, each as a
// model entry would name it.
func (c *Catalog) indexByName() map[string][]string {
	index := map[string][]string{}
	for _, loc := range c.Places.Locations() {
		if st, err := os.Stat(loc.Path); err != nil || !st.IsDir() {
			continue
		}
		filepath.WalkDir(loc.Path, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".gguf") {
				return nil
			}
			rel, _ := filepath.Rel(loc.Path, p)
			index[d.Name()] = append(index[d.Name()], locations.Ref(loc.Key, filepath.ToSlash(rel)))
			return nil
		})
	}
	for _, names := range index {
		sort.Strings(names)
	}
	return index
}

func gib(size int64) float64 { return math.RoundToEven(float64(size)/(1<<30)*100) / 100 }

// groupSplits makes one entry per model, since every part of a split is
// needed and a lone part loads as nothing.
func (c *Catalog) groupSplits(raw [][2]any, repoID string) []api.CatalogFile {
	type group struct {
		parts     []string
		size      int64
		isMmproj  bool
		partCount int
	}
	groups := map[string]*group{}
	var order []string
	for _, item := range raw {
		name, _ := item[0].(string)
		size, _ := item[1].(int64)
		key := name
		count := 1
		if m := split.FindStringSubmatch(name); m != nil {
			key = m[1]
			count, _ = strconv.Atoi(m[3])
		}
		g, ok := groups[key]
		if !ok {
			g = &group{isMmproj: strings.HasPrefix(strings.ToLower(path.Base(name)), "mmproj"), partCount: count}
			groups[key] = g
			order = append(order, key)
		}
		g.parts = append(g.parts, name)
		g.size += size
	}
	onDisk := c.indexByName()
	out := []api.CatalogFile{}
	for _, key := range order {
		g := groups[key]
		parts := append([]string{}, g.parts...)
		sort.Strings(parts)
		// On disk when every part is in one location at the path a download
		// would have given it; otherwise where the default would put it.
		home := c.Places.DefaultLocation("gguf")
		all := false
		for _, loc := range c.Places.Locations() {
			complete := true
			for _, p := range parts {
				if _, err := os.Stat(LocalPath(loc, repoID, p)); err != nil {
					complete = false
					break
				}
			}
			if complete {
				home, all = loc, true
				break
			}
		}
		mine := locations.Ref(home.Key, filepath.ToSlash(relPath(repoID, parts[0])))
		elsewhere := []string{}
		for _, where := range onDisk[filepath.Base(relPath(repoID, parts[0]))] {
			if where != mine {
				elsewhere = append(elsewhere, where)
			}
		}
		out = append(out, api.CatalogFile{
			Filename: parts[0], Parts: parts, PartCount: len(parts), SizeBytes: g.size, SizeGiB: gib(g.size),
			IsMmproj: g.isMmproj, OnDisk: all, LocalPath: mine, Elsewhere: elsewhere,
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].SizeBytes > out[j].SizeBytes })
	return out
}

// ListFiles is the GGUF files in a repo with sizes, so the UI can warn
// before a 40 GiB pull.
func (c *Catalog) ListFiles(ctx context.Context, repoID string) []api.CatalogFile {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, hfAPI+"/models/"+repoID+"?blobs=true", nil)
	resp, err := c.http.Do(req)
	if err != nil {
		log.Printf("HF file listing for %s failed: %v", repoID, err)
		return []api.CatalogFile{}
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		log.Printf("HF file listing for %s failed: HTTP %d", repoID, resp.StatusCode)
		return []api.CatalogFile{}
	}
	var data struct {
		Siblings []struct {
			Name string `json:"rfilename"`
			Size *int64 `json:"size"`
		} `json:"siblings"`
	}
	if json.NewDecoder(resp.Body).Decode(&data) != nil {
		return []api.CatalogFile{}
	}
	var raw [][2]any
	for _, s := range data.Siblings {
		if !strings.HasSuffix(strings.ToLower(s.Name), ".gguf") {
			continue
		}
		var size int64
		if s.Size != nil {
			size = *s.Size
		}
		raw = append(raw, [2]any{s.Name, size})
	}
	return c.groupSplits(raw, repoID)
}

type download struct {
	repoID, filename string
	location         locations.Location
	total, done      int64
	state            string
	err              string
	startedAt        time.Time
	// resumed is what was on disk when this run began, excluded from the
	// rate so a resume does not report an inflated speed.
	resumed int64
	cancel  context.CancelFunc
}

func (d *download) snapshot() api.Download {
	elapsed := time.Since(d.startedAt).Seconds()
	if elapsed < 0.001 {
		elapsed = 0.001
	}
	fresh := d.done - d.resumed
	if fresh < 0 {
		fresh = 0
	}
	percent := 0.0
	if d.total > 0 {
		percent = math.RoundToEven(float64(d.done)/float64(d.total)*1000) / 10
	}
	out := api.Download{RepoID: d.repoID, Filename: d.filename, Location: d.location.Key,
		LocalPath:  locations.Ref(d.location.Key, filepath.ToSlash(relPath(d.repoID, d.filename))),
		TotalBytes: d.total, DownloadedBytes: d.done,
		Percent: percent, State: d.state, MiBPerSecond: math.RoundToEven(float64(fresh)/elapsed/1024/1024*10) / 10}
	if d.err != "" {
		e := d.err
		out.Error = &e
	}
	return out
}

func key(repoID, filename string) string { return repoID + "/" + filename }

// UnknownLocation is a download asked for a location that is not one.
type UnknownLocation struct{ Key string }

func (e *UnknownLocation) Error() string { return "沒有這個下載位置：" + e.Key }

// Start begins a download into a location -- the GGUF default when none
// is named -- or reports the one already running for that file.
func (c *Catalog) Start(repoID, filename, location string) (api.Download, error) {
	loc := c.Places.DefaultLocation("gguf")
	if location != "" {
		found := false
		for _, l := range c.Places.Locations() {
			if l.Key == location {
				loc, found = l, true
			}
		}
		if !found {
			return api.Download{}, &UnknownLocation{location}
		}
	}
	k := key(repoID, filename)
	c.mu.Lock()
	defer c.mu.Unlock()
	if existing, ok := c.downloads[k]; ok && (existing.state == "queued" || existing.state == "downloading") {
		return existing.snapshot(), nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	d := &download{repoID: repoID, filename: filename, location: loc, state: "queued", startedAt: time.Now(), cancel: cancel}
	if _, ok := c.downloads[k]; !ok {
		c.order = append(c.order, k)
	}
	c.downloads[k] = d
	go c.run(ctx, d)
	return d.snapshot(), nil
}

// ActiveIn says whether a download is writing into a location, which is
// what stops the location being removed.
func (c *Catalog) ActiveIn(location string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, d := range c.downloads {
		if d.location.Key == location && (d.state == "queued" || d.state == "downloading") {
			return true
		}
	}
	return false
}

func (c *Catalog) Cancel(repoID, filename string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	d, ok := c.downloads[key(repoID, filename)]
	if !ok || (d.state != "queued" && d.state != "downloading") {
		return false
	}
	d.cancel()
	return true
}

func (c *Catalog) Status() []api.Download {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]api.Download, 0, len(c.order))
	for _, k := range c.order {
		out = append(out, c.downloads[k].snapshot())
	}
	return out
}

// ActiveCount counts queued too: a job accepted but not started is still
// something the UI is waiting on.
func (c *Catalog) ActiveCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, d := range c.downloads {
		if d.state == "queued" || d.state == "downloading" {
			n++
		}
	}
	return n
}

// totalSize asks for one byte and reads the total out of Content-Range,
// which also proves the server supports ranges at all.
func totalSize(ctx context.Context, client *http.Client, url string) (int64, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	req.Header.Set("Range", "bytes=0-0")
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode >= 400 {
		return 0, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if cr := resp.Header.Get("Content-Range"); strings.Contains(cr, "/") {
		return strconv.ParseInt(cr[strings.LastIndex(cr, "/")+1:], 10, 64)
	}
	return strconv.ParseInt(resp.Header.Get("Content-Length"), 10, 64)
}

type ledger struct {
	Done  []int `json:"done"`
	Total int64 `json:"total"`
}

// loadDone is the segments already fetched, believed only while the .part
// they describe is still on disk and the remote size still matches.
func loadDone(statePath, partial string, segments int, total int64) map[int]bool {
	done := map[int]bool{}
	if _, err := os.Stat(partial); err != nil {
		os.Remove(statePath)
		return done
	}
	b, err := os.ReadFile(statePath)
	if err != nil {
		return done
	}
	var l ledger
	if json.Unmarshal(b, &l) != nil {
		return done
	}
	if l.Total != total {
		os.Remove(statePath)
		return done
	}
	for _, i := range l.Done {
		if i >= 0 && i < segments {
			done[i] = true
		}
	}
	return done
}

func saveDone(statePath string, done map[int]bool, total int64) {
	l := ledger{Total: total, Done: []int{}}
	for i := range done {
		l.Done = append(l.Done, i)
	}
	sort.Ints(l.Done)
	b, _ := json.Marshal(l)
	tmp := statePath + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		os.Rename(tmp, statePath)
	}
}

// materialised is bytes actually written: the file is preallocated, so
// only the allocated blocks distinguish finished from full of holes.
func materialised(p string) int64 {
	var st syscall.Stat_t
	if err := syscall.Stat(p, &st); err != nil {
		return 0
	}
	return st.Blocks * 512
}

func (c *Catalog) fetchSegment(ctx context.Context, client *http.Client, url string, f *os.File, index int, total int64, d *download) error {
	start := int64(index) * segmentSize
	end := start + segmentSize
	if end > total {
		end = total
	}
	end--
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 && resp.StatusCode != 206 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	offset := start
	var contributed int64
	buf := make([]byte, chunk)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.WriteAt(buf[:n], offset); werr != nil {
				c.rollback(d, contributed)
				return werr
			}
			offset += int64(n)
			contributed += int64(n)
			c.mu.Lock()
			d.done += int64(n)
			c.mu.Unlock()
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			// A retry re-downloads the whole segment, so a partial attempt
			// must not stay counted.
			c.rollback(d, contributed)
			return err
		}
	}
}

func (c *Catalog) rollback(d *download, n int64) {
	c.mu.Lock()
	d.done -= n
	c.mu.Unlock()
}

func (c *Catalog) set(d *download, fn func()) {
	c.mu.Lock()
	fn()
	c.mu.Unlock()
}

func (c *Catalog) run(ctx context.Context, d *download) {
	url := "https://huggingface.co/" + d.repoID + "/resolve/main/" + d.filename
	target := LocalPath(d.location, d.repoID, d.filename)
	partial := target + ".part"
	statePath := partial + ".state"
	c.set(d, func() { d.state = "downloading"; d.startedAt = time.Now() })

	err := func() error {
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		client := &http.Client{Timeout: 0, Transport: &http.Transport{MaxConnsPerHost: parallel + 2,
			MaxIdleConnsPerHost: parallel, ResponseHeaderTimeout: 30 * time.Second}}
		total, err := totalSize(ctx, client, url)
		if err != nil {
			return err
		}
		if total <= 0 {
			return errors.New("could not determine the remote file size")
		}
		segments := int((total + segmentSize - 1) / segmentSize)
		done := loadDone(statePath, partial, segments, total)
		var have int64
		for i := range done {
			end := int64(i+1) * segmentSize
			if end > total {
				end = total
			}
			have += end - int64(i)*segmentSize
		}
		if len(done) > 0 {
			log.Printf("resuming %s with %d/%d segments already present", d.filename, len(done), segments)
		}
		c.set(d, func() { d.total = total; d.done = have; d.resumed = have })

		f, err := os.OpenFile(partial, os.O_RDWR|os.O_CREATE, 0o644)
		if err != nil {
			return err
		}
		defer f.Close()
		// Sparse until written, so preallocating costs no disk up front.
		if err := f.Truncate(total); err != nil {
			return err
		}
		pending := make(chan int, segments)
		for i := 0; i < segments; i++ {
			if !done[i] {
				pending <- i
			}
		}
		close(pending)
		var ledgerMu sync.Mutex
		var wg sync.WaitGroup
		var firstErr error
		var errMu sync.Mutex
		workers := parallel
		if segments < workers {
			workers = segments
		}
		workCtx, stop := context.WithCancel(ctx)
		defer stop()
		for w := 0; w < workers; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for index := range pending {
					if workCtx.Err() != nil {
						return
					}
					var err error
					for attempt := 0; attempt < 3; attempt++ {
						err = c.fetchSegment(workCtx, client, url, f, index, total, d)
						if err == nil || workCtx.Err() != nil {
							break
						}
						log.Printf("segment %d of %s failed (%v); retrying", index, d.filename, err)
						select {
						case <-workCtx.Done():
							return
						case <-time.After(time.Duration(1+attempt) * time.Second):
						}
					}
					if err != nil {
						errMu.Lock()
						if firstErr == nil {
							firstErr = err
						}
						errMu.Unlock()
						stop()
						return
					}
					ledgerMu.Lock()
					done[index] = true
					saveDone(statePath, done, total)
					ledgerMu.Unlock()
				}
			}()
		}
		wg.Wait()
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if firstErr != nil {
			return firstErr
		}
		// Two independent checks: the ledger proves every range was fetched,
		// the allocated size proves the writes reached the disk.
		if missing := segments - len(done); missing > 0 {
			return fmt.Errorf("%d/%d 個段落未完成", missing, segments)
		}
		if actual := materialised(partial); float64(actual) < float64(total)*0.99 {
			return fmt.Errorf("檔案不完整：實際寫入 %.2f GiB，應為 %.2f GiB", float64(actual)/(1<<30), float64(total)/(1<<30))
		}
		f.Close()
		if err := os.Rename(partial, target); err != nil {
			return err
		}
		os.Remove(statePath)
		c.set(d, func() { d.done = total; d.state = "done" })
		log.Printf("downloaded %s (%.1f GiB)", filepath.Base(target), float64(total)/(1<<30))
		return nil
	}()
	if err == nil {
		return
	}
	if errors.Is(err, context.Canceled) {
		// .part and .part.state are kept on purpose so a retry resumes.
		c.set(d, func() { d.state = "cancelled" })
		return
	}
	c.set(d, func() { d.state = "error"; d.err = err.Error() })
	log.Printf("download of %s failed: %v", d.filename, err)
}
