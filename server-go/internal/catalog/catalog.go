// Package catalog searches Hugging Face and downloads models: a GGUF file
// for llama.cpp, or a whole repository of safetensors for a server engine
// such as vLLM. Downloads are segmented because one TCP stream to the CDN
// could not exceed about 8 MiB/s here while seven reached 41; the limit is
// the bandwidth-delay product of one connection, not the server. Every file
// the Hub lists a sha256 for is checked against it before it is kept.
package catalog

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	"github.com/NoobBandi/TenkStack/server-go/internal/hfmodel"
	"github.com/NoobBandi/TenkStack/server-go/internal/locations"
)

const (
	huggingFace = "https://huggingface.co"
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
	// Hub is Hugging Face's address; a test points it elsewhere.
	Hub string
	// Token is the owner's Hugging Face token, "" when none is set; it is
	// what opens a gated repository.
	Token func() string
	http  *http.Client

	// kinds is what a config.json said about each architecture: moe or
	// dense. Search results name their architecture but not their experts,
	// and an architecture keeps its answer, so each is asked about once.
	kindsMu sync.Mutex
	kinds   map[string]string

	mu        sync.Mutex
	downloads map[string]*download
	order     []string
}

func New(places Places) *Catalog {
	return &Catalog{Places: places, Hub: huggingFace, http: &http.Client{Timeout: 20 * time.Second}, downloads: map[string]*download{}}
}

// authorize signs a request to the Hub with the owner's token, when there is
// one. Go does not carry it on to the CDN the Hub redirects a file to.
func (c *Catalog) authorize(req *http.Request) {
	if c.Token == nil {
		return
	}
	if t := c.Token(); t != "" {
		req.Header.Set("Authorization", "Bearer "+t)
	}
}

// NeedsAccess is a gated repository the Hub would not open.
type NeedsAccess struct{ HasToken bool }

func (e *NeedsAccess) Error() string {
	if e.HasToken {
		return "這個模型需要授權，目前的 token 還沒有權限：到 Hugging Face 的模型頁同意使用條款（有些要等作者核准）"
	}
	return "這個模型需要授權：先到 Hugging Face 的模型頁同意使用條款，再到「設定」填入 Hugging Face token"
}

// refused turns the Hub's 401 and 403 into NeedsAccess.
func (c *Catalog) refused(status int) error {
	if status == http.StatusUnauthorized || status == http.StatusForbidden {
		return &NeedsAccess{HasToken: c.Token != nil && c.Token() != ""}
	}
	return fmt.Errorf("HTTP %d", status)
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

// Formats are the file formats the catalog can search for; "all" is both.
var Formats = []string{"gguf", "safetensors", "all"}

// Search lists repos of one format, or of both, sorted by downloads, a
// hundred at a time since the page pages through them locally. Each carries
// its format, which decides how the page shows it: a GGUF repository is a
// choice of files, a safetensors one a folder. A repository of GGUF files
// that also carries a few safetensors, or an MLX export, is not offered as
// a folder.
func (c *Catalog) Search(ctx context.Context, query string, limit int, format string) []api.CatalogRepo {
	if format != "all" {
		if format != "safetensors" {
			format = "gguf"
		}
		return c.search(ctx, query, limit, format)
	}
	// Both at once, merged by downloads: a newcomer looking for a model
	// need not know which format to ask for.
	var gguf, st []api.CatalogRepo
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); gguf = c.search(ctx, query, limit, "gguf") }()
	go func() { defer wg.Done(); st = c.search(ctx, query, limit, "safetensors") }()
	wg.Wait()
	// Up to limit of each: the page filters by format, and each format's
	// list should be as long as a search of that format alone.
	seen := map[any]bool{}
	out := []api.CatalogRepo{}
	for _, r := range append(gguf, st...) {
		if !seen[r.RepoID] {
			seen[r.RepoID] = true
			out = append(out, r)
		}
	}
	downloads := func(r api.CatalogRepo) float64 { f, _ := r.Downloads.(float64); return f }
	sort.SliceStable(out, func(i, j int) bool { return downloads(out[i]) > downloads(out[j]) })
	return out
}

func (c *Catalog) search(ctx context.Context, query string, limit int, format string) []api.CatalogRepo {
	out := []api.CatalogRepo{}
	q := url.Values{}
	q.Set("search", query)
	q.Set("filter", format)
	q.Set("limit", strconv.Itoa(limit))
	q.Set("sort", "downloads")
	q.Set("direction", "-1")
	for _, f := range []string{"downloads", "likes", "tags", "lastModified", "gated", "config", "gguf"} {
		q.Add("expand[]", f)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, c.Hub+"/api/models?"+q.Encode(), nil)
	c.authorize(req)
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
		if format == "safetensors" && notForServer(m) {
			continue
		}
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
		r := api.CatalogRepo{RepoID: m["id"], Downloads: m["downloads"], Likes: m["likes"], LastModified: m["lastModified"], Tags: tags,
			Gated: isGated(m["gated"]), Format: format}
		r.Kind, _, _ = kindOf(m)
		if r.Downloads == nil {
			r.Downloads = 0
		}
		if r.Likes == nil {
			r.Likes = 0
		}
		out = append(out, r)
	}
	c.confirmKinds(ctx, repos, out, format)
	return out
}

// activeParams is the "30B-A3B" way of naming a mixture of experts: its
// total, and the parameters active for each token.
var activeParams = regexp.MustCompile(`(?i)\d+(\.\d+)?b-a\d+(\.\d+)?b`)

// moeArchitectures are GGUF and config architectures that are a mixture of
// experts without saying moe in their name.
var moeArchitectures = map[string]bool{
	"deepseek2": true, "deepseek_v2": true, "deepseek_v3": true, "deepseek3": true, "mixtral": true,
	"gptoss": true, "gpt_oss": true, "gpt-oss": true, "llama4": true, "dbrx": true, "jamba": true,
	"grok": true, "arctic": true, "kimi_k2": true,
}

// kindOf says whether a search result is a dense model or a mixture of
// experts, from what the Hub knows without a download: the architecture in
// its GGUF header or config.json (qwen3moe, qwen3_5_moe, deepseek_v3, …),
// then its name. Only moe is ever certain here; "dense" means nothing said
// otherwise, which an architecture named without the word -- Flash-Next's
// qwen4exp -- gets wrong, so the caller asks that architecture's config.
// arch is the name to ask about. "" when nothing is known: Mixtral's GGUF,
// for one, calls itself llama.
func kindOf(m map[string]any) (kind, arch string, sure bool) {
	var archs []string
	if g, _ := m["gguf"].(map[string]any); g != nil {
		if a, _ := g["architecture"].(string); a != "" && a != "clip" {
			archs = append(archs, a)
		}
	}
	if c, _ := m["config"].(map[string]any); c != nil {
		if t, _ := c["model_type"].(string); t != "" {
			archs = append(archs, t)
		}
		if list, _ := c["architectures"].([]any); len(list) > 0 {
			if a, _ := list[0].(string); a != "" {
				archs = append(archs, a)
			}
		}
	}
	id, _ := m["id"].(string)
	name := strings.ToLower(id)
	for _, a := range archs {
		lower := strings.ToLower(a)
		if strings.Contains(lower, "moe") || moeArchitectures[lower] {
			return "moe", lower, true
		}
	}
	if activeParams.MatchString(name) || strings.Contains(name, "moe") || strings.Contains(name, "mixtral") {
		return "moe", "", true
	}
	if list, _ := m["tags"].([]any); list != nil {
		for _, t := range list {
			if s, _ := t.(string); s == "moe" || s == "mixture-of-experts" {
				return "moe", "", true
			}
		}
	}
	if len(archs) > 0 {
		return "dense", strings.ToLower(archs[0]), false
	}
	return "", "", false
}

// configSource is the repository whose config.json says what a search
// result's model is: its own, for safetensors; the model a GGUF was made
// from, which the Hub records as a base_model tag.
func configSource(m map[string]any, format string) string {
	id, _ := m["id"].(string)
	if format == "safetensors" {
		return id
	}
	list, _ := m["tags"].([]any)
	plain := ""
	for _, t := range list {
		s, _ := t.(string)
		if r, ok := strings.CutPrefix(s, "base_model:quantized:"); ok {
			return r
		}
		if r, ok := strings.CutPrefix(s, "base_model:"); ok && !strings.Contains(r, ":") && plain == "" {
			plain = r
		}
	}
	return plain
}

// confirmKinds settles the results that only looked dense by asking one
// config.json per architecture not asked about before, a few at a time.
// One that cannot be read -- a gated base model, say -- keeps its guess.
func (c *Catalog) confirmKinds(ctx context.Context, raw []map[string]any, out []api.CatalogRepo, format string) {
	type pending struct {
		arch, source string
	}
	var ask []pending
	c.kindsMu.Lock()
	if c.kinds == nil {
		c.kinds = map[string]string{}
	}
	asked := map[string]bool{}
	for _, m := range raw {
		key, source := c.kindKey(m, format)
		if key == "" || asked[key] {
			continue
		}
		if _, known := c.kinds[key]; known {
			continue
		}
		if source != "" {
			asked[key] = true
			ask = append(ask, pending{key, source})
		}
	}
	c.kindsMu.Unlock()
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for _, p := range ask {
		wg.Add(1)
		go func(p pending) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
			defer cancel()
			raw, err := c.fetchSmall(ctx, p.source, "config.json")
			if err != nil {
				return
			}
			kind := "dense"
			if hfmodel.Parse(raw).Experts > 0 {
				kind = "moe"
			}
			c.kindsMu.Lock()
			c.kinds[p.arch] = kind
			c.kindsMu.Unlock()
		}(p)
	}
	wg.Wait()
	c.kindsMu.Lock()
	defer c.kindsMu.Unlock()
	byID := map[any]int{}
	for i, r := range out {
		byID[r.RepoID] = i
	}
	for _, m := range raw {
		key, _ := c.kindKey(m, format)
		if i, ok := byID[m["id"]]; ok && key != "" {
			if kind, known := c.kinds[key]; known {
				out[i].Kind = kind
			}
		}
	}
}

// kindKey is what a result's kind is remembered under, and the repository
// whose config.json settles it: its architecture, or -- when the Hub read
// only a vision projector's header and knows none -- the base model itself.
// "" for a result already certain, or with nothing to ask.
func (c *Catalog) kindKey(m map[string]any, format string) (key, source string) {
	_, arch, sure := kindOf(m)
	if sure {
		return "", ""
	}
	source = configSource(m, format)
	if arch != "" {
		return arch, source
	}
	if source != "" {
		return "base:" + source, source
	}
	return "", ""
}

// isGated reads the Hub's gated field: false, or "auto" / "manual".
func isGated(v any) bool {
	s, ok := v.(string)
	return ok && s != "" && s != "false"
}

// notForServer is a repository a server engine cannot load as a folder even
// though it holds safetensors: GGUF files with a few extras, or an export for
// Apple's MLX, whose tensors are laid out for that runtime only.
func notForServer(m map[string]any) bool {
	id, _ := m["id"].(string)
	lower := strings.ToLower(id)
	if strings.HasSuffix(lower, "gguf") || strings.Contains(lower, "-mlx") {
		return true
	}
	list, _ := m["tags"].([]any)
	for _, t := range list {
		if s, _ := t.(string); s == "gguf" || s == "mlx" {
			return true
		}
	}
	return false
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

// remoteFile is one file of a repository as the Hub lists it.
type remoteFile struct {
	Name string
	Size int64
	// SHA256 is the Hub's own digest of an LFS file, which every weight
	// file is; empty for a small file kept in git.
	SHA256 string
}

// remoteFiles lists a repository's files with sizes and digests.
func (c *Catalog) remoteFiles(ctx context.Context, repoID string) ([]remoteFile, error) {
	files, _, err := c.listing(ctx, repoID)
	return files, err
}

// listing is a repository's files and whether it is gated.
func (c *Catalog) listing(ctx context.Context, repoID string) ([]remoteFile, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, c.Hub+"/api/models/"+repoID+"?blobs=true", nil)
	c.authorize(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, false, c.refused(resp.StatusCode)
	}
	var data struct {
		Gated    any `json:"gated"`
		Siblings []struct {
			Name string `json:"rfilename"`
			Size *int64 `json:"size"`
			LFS  *struct {
				SHA256 string `json:"sha256"`
				Size   int64  `json:"size"`
			} `json:"lfs"`
		} `json:"siblings"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, false, err
	}
	out := make([]remoteFile, 0, len(data.Siblings))
	for _, s := range data.Siblings {
		f := remoteFile{Name: s.Name}
		if s.Size != nil {
			f.Size = *s.Size
		}
		if s.LFS != nil {
			f.SHA256 = s.LFS.SHA256
			if f.Size == 0 {
				f.Size = s.LFS.Size
			}
		}
		out = append(out, f)
	}
	return out, isGated(data.Gated), nil
}

// ListFiles is the GGUF files in a repo with sizes, so the UI can warn
// before a 40 GiB pull.
func (c *Catalog) ListFiles(ctx context.Context, repoID string) []api.CatalogFile {
	files, err := c.remoteFiles(ctx, repoID)
	if err != nil {
		log.Printf("HF file listing for %s failed: %v", repoID, err)
		return []api.CatalogFile{}
	}
	var raw [][2]any
	for _, f := range files {
		if strings.HasSuffix(strings.ToLower(f.Name), ".gguf") {
			raw = append(raw, [2]any{f.Name, f.Size})
		}
	}
	return c.groupSplits(raw, repoID)
}

// folderFiles is what a server engine needs of a repository: the weights,
// every config and tokenizer file, the chat template and any code the
// model class ships. Left out: a second copy of the weights in an older
// format, the original checkpoints some publishers add under original/,
// GGUF and ONNX exports, and pictures for the model card.
func folderFiles(all []remoteFile) []remoteFile {
	hasSafetensors := false
	for _, f := range all {
		if strings.HasSuffix(strings.ToLower(f.Name), ".safetensors") {
			hasSafetensors = true
		}
	}
	var out []remoteFile
	for _, f := range all {
		lower := strings.ToLower(f.Name)
		dir := strings.SplitN(lower, "/", 2)[0]
		if strings.Contains(lower, "/") && (dir == "original" || dir == "consolidated" || dir == "onnx" ||
			dir == "gguf" || dir == "images" || dir == "assets" || dir == "figures") {
			continue
		}
		base := path.Base(lower)
		if strings.HasPrefix(base, ".") || strings.HasPrefix(base, "consolidated") || base == "readme.md" {
			continue
		}
		switch path.Ext(base) {
		case ".gguf", ".onnx", ".onnx_data", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".mp4", ".pdf":
			continue
		case ".bin", ".pt", ".pth", ".ckpt", ".h5", ".msgpack":
			if hasSafetensors {
				continue
			}
		}
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Folder is a repository as a server engine would load it: what it needs of
// it, what its config says the model is, and whether it is on disk.
func (c *Catalog) Folder(ctx context.Context, repoID string) (api.CatalogFolder, error) {
	all, gated, err := c.listing(ctx, repoID)
	if err != nil {
		return api.CatalogFolder{}, err
	}
	files := folderFiles(all)
	out := api.CatalogFolder{RepoID: repoID, Files: []api.CatalogFolderFile{}, Gated: gated}
	hasWeights := false
	for _, f := range files {
		out.Files = append(out.Files, api.CatalogFolderFile{Name: f.Name, SizeBytes: f.Size})
		out.SizeBytes += f.Size
		if strings.HasSuffix(strings.ToLower(f.Name), ".safetensors") {
			hasWeights = true
		}
	}
	out.SizeGiB = gib(out.SizeBytes)
	out.Loadable = hasWeights
	raw, err := c.fetchSmall(ctx, repoID, "config.json")
	var needs *NeedsAccess
	switch {
	case err == nil:
		cfg := hfmodel.Parse(raw)
		out.Architecture, out.Precision, out.Quantized = cfg.Architecture, cfg.Precision, cfg.Quantized
		out.Vision, out.MTP, out.ContextLength = cfg.Vision, cfg.MTP, cfg.ContextLength
		out.KVBytesPerToken, out.Hybrid = cfg.KVBytesPerToken, cfg.Hybrid
		out.Experts, out.ExpertsActive = cfg.Experts, cfg.ExpertsActive
	case errors.As(err, &needs):
		// The listing is public, the files are not: what it is stays unknown
		// until the Hub lets the token in.
		out.NeedsAccess = needs.Error()
	default:
		out.Loadable = false
	}
	// On disk when every file is where a download would have put it, at its
	// size, in one location; otherwise where the default would put it, and
	// how much of it is already there.
	home := c.Places.DefaultLocation("safetensors")
	for _, loc := range c.Places.Locations() {
		have := int64(0)
		for _, f := range files {
			if st, err := os.Stat(LocalPath(loc, repoID, f.Name)); err == nil && st.Size() == f.Size {
				have += f.Size
			}
		}
		if have > 0 && have == out.SizeBytes {
			home, out.OnDisk, out.PresentBytes = loc, true, have
			break
		}
		if loc.Key == home.Key {
			out.PresentBytes = have
		}
	}
	out.Location = home.Key
	out.LocalPath = locations.Ref(home.Key, filepath.ToSlash(relPath(repoID, "")))
	return out, nil
}

// Variants is the same model in other precisions a server engine could
// load: the repository it was quantised from, and every quantisation of that
// one the Hub lists, most downloaded first. The precision and size are read
// from the Hub's own tensor counts and tags, before anything is fetched; the
// folder panel reads each one's config.json when it is picked.
func (c *Catalog) Variants(ctx context.Context, repoID string, limit int) ([]api.CatalogVariant, error) {
	self, err := c.hubModel(ctx, repoID)
	if err != nil {
		return nil, err
	}
	root := repoID
	for _, t := range self.Tags {
		if r, ok := strings.CutPrefix(t, "base_model:quantized:"); ok {
			root = r
		}
	}
	var candidates []hubModel
	if root != repoID {
		if base, err := c.hubModel(ctx, root); err == nil {
			candidates = append(candidates, base)
		}
	}
	q := url.Values{}
	q.Add("filter", "base_model:quantized:"+root)
	q.Add("filter", "safetensors")
	q.Set("sort", "downloads")
	q.Set("direction", "-1")
	q.Set("limit", strconv.Itoa(limit*2))
	for _, f := range []string{"tags", "safetensors", "downloads", "gated"} {
		q.Add("expand[]", f)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, c.Hub+"/api/models?"+q.Encode(), nil)
	c.authorize(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, c.refused(resp.StatusCode)
	}
	var listed []hubModel
	if err := json.NewDecoder(resp.Body).Decode(&listed); err != nil {
		return nil, err
	}
	candidates = append(candidates, listed...)
	out := []api.CatalogVariant{}
	for _, m := range candidates {
		tags := make([]any, len(m.Tags))
		for i, t := range m.Tags {
			tags[i] = t
		}
		if m.ID == repoID || notForServer(map[string]any{"id": m.ID, "tags": tags}) {
			continue
		}
		precision, size := coarsePrecision(m.ID, m.Tags, m.Safetensors.Parameters)
		out = append(out, api.CatalogVariant{RepoID: m.ID, Precision: precision, SizeGiB: gib(size),
			Downloads: m.Downloads, Gated: isGated(m.Gated), Base: m.ID == root})
		if len(out) == limit {
			break
		}
	}
	// The sizes the Hub's counts give are only a floor: a packed format is
	// counted by the values it holds, and not the same way by every
	// publisher. What a download would fetch is the size to show, read from
	// each listing, a few at a time.
	var wg sync.WaitGroup
	sem := make(chan struct{}, 6)
	for i := range out {
		wg.Add(1)
		go func(v *api.CatalogVariant) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			files, err := c.remoteFiles(ctx, v.RepoID)
			if err != nil {
				return
			}
			var total int64
			for _, f := range folderFiles(files) {
				total += f.Size
			}
			if total > 0 {
				v.SizeGiB = gib(total)
			}
		}(&out[i])
	}
	wg.Wait()
	return out, nil
}

// hubModel is one model as the Hub's API lists it.
type hubModel struct {
	ID          string   `json:"id"`
	Tags        []string `json:"tags"`
	Downloads   int64    `json:"downloads"`
	Gated       any      `json:"gated"`
	Safetensors struct {
		Parameters map[string]int64 `json:"parameters"`
	} `json:"safetensors"`
}

func (c *Catalog) hubModel(ctx context.Context, repoID string) (hubModel, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	q := url.Values{}
	for _, f := range []string{"tags", "safetensors", "downloads", "gated"} {
		q.Add("expand[]", f)
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, c.Hub+"/api/models/"+repoID+"?"+q.Encode(), nil)
	c.authorize(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return hubModel{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return hubModel{}, c.refused(resp.StatusCode)
	}
	var m hubModel
	err = json.NewDecoder(resp.Body).Decode(&m)
	return m, err
}

// coarsePrecision names a repository's precision from its name, which is
// usually the most exact thing about it, else its tags, else the Hub's count
// of parameters by dtype. The size it gives is the part of that count whose
// width is certain: packed integers are counted by the values they hold,
// differently by different publishers, and left out.
func coarsePrecision(id string, tags []string, params map[string]int64) (string, int64) {
	width := map[string]int64{"BF16": 2, "F16": 2, "F32": 4, "F8_E4M3": 1, "F8_E5M2": 1}
	var size int64
	for dtype, n := range params {
		size += n * width[dtype]
	}
	name := strings.ToLower(id[strings.LastIndex(id, "/")+1:])
	has := map[string]bool{}
	for _, t := range tags {
		has[strings.ToLower(t)] = true
	}
	// bitsandbytes first: a "bnb-4bit" is not the int4 an engine's own
	// quantisation writes, and loads (or not) on its own terms.
	for _, rule := range []struct {
		marks     []string
		precision string
	}{
		{[]string{"bnb", "bitsandbytes"}, "bnb"},
		{[]string{"nvfp4"}, "nvfp4"},
		{[]string{"mxfp4"}, "mxfp4"},
		{[]string{"awq"}, "awq"},
		{[]string{"gptq"}, "gptq"},
		{[]string{"fp8", "nvfp8"}, "fp8"},
		{[]string{"w4a16", "int4", "4bit", "4-bit"}, "int4"},
		{[]string{"w8a16", "w8a8", "int8", "8bit", "8-bit"}, "int8"},
	} {
		for _, mark := range rule.marks {
			if strings.Contains(name, mark) {
				return rule.precision, size
			}
		}
	}
	for _, rule := range []struct{ tag, precision string }{
		{"bitsandbytes", "bnb"}, {"nvfp4", "nvfp4"}, {"mxfp4", "mxfp4"}, {"awq", "awq"}, {"gptq", "gptq"},
		{"fp8", "fp8"}, {"int4", "int4"}, {"4-bit", "int4"}, {"int8", "int8"}, {"8-bit", "int8"},
	} {
		if has[rule.tag] {
			return rule.precision, size
		}
	}
	switch {
	case params["F8_E4M3"]+params["F8_E5M2"] > 0:
		return "fp8", size
	case params["I32"]+params["U8"]+params["U32"] > 0:
		return "int4", size
	case params["BF16"] > 0:
		return "bf16", size
	case params["F16"] > 0:
		return "fp16", size
	case params["F32"] > 0:
		return "fp32", size
	}
	return "", size
}

// fetchSmall reads a small file of a repository whole.
func (c *Catalog) fetchSmall(ctx context.Context, repoID, name string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, c.Hub+"/"+repoID+"/resolve/main/"+name, nil)
	c.authorize(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, c.refused(resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 4<<20))
}

type download struct {
	repoID, filename string
	// files is set for a whole repository, a server engine's folder; a
	// single GGUF has none and is filename.
	files       []remoteFile
	location    locations.Location
	total, done int64
	// base is the bytes of the files already finished, which a file's own
	// progress is counted on top of.
	base      int64
	filesDone int
	current   string
	state     string
	err       string
	startedAt time.Time
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
		Percent: percent, State: d.state, MiBPerSecond: math.RoundToEven(float64(fresh)/elapsed/1024/1024*10) / 10,
		Kind: "file"}
	if d.files != nil {
		out.Kind, out.Files, out.FilesDone, out.Current = "folder", len(d.files), d.filesDone, d.current
	}
	if d.err != "" {
		e := d.err
		out.Error = &e
	}
	return out
}

// active is a download still running: queued, fetching, or checking what
// it fetched.
func (d *download) active() bool {
	return d.state == "queued" || d.state == "downloading" || d.state == "verifying"
}

func key(repoID, filename string) string { return repoID + "/" + filename }

// UnknownLocation is a download asked for a location that is not one.
type UnknownLocation struct{ Key string }

func (e *UnknownLocation) Error() string { return "沒有這個下載位置：" + e.Key }

// Start begins a download into a location -- the GGUF default when none
// is named -- or reports the one already running for that file.
func (c *Catalog) Start(repoID, filename, location string) (api.Download, error) {
	return c.start(repoID, filename, nil, location, "gguf")
}

// StartFolder begins downloading what a server engine needs of a
// repository, into a location -- the safetensors default when none is
// named -- or reports the one already running for it. Files already there
// at their size are kept.
func (c *Catalog) StartFolder(ctx context.Context, repoID, location string) (api.Download, error) {
	all, err := c.remoteFiles(ctx, repoID)
	if err != nil {
		return api.Download{}, fmt.Errorf("讀不到 %s 的檔案清單：%w", repoID, err)
	}
	files := folderFiles(all)
	if len(files) == 0 {
		return api.Download{}, fmt.Errorf("%s 沒有可以下載的模型檔案", repoID)
	}
	return c.start(repoID, "", files, location, "safetensors")
}

func (c *Catalog) start(repoID, filename string, files []remoteFile, location, format string) (api.Download, error) {
	loc := c.Places.DefaultLocation(format)
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
	if existing, ok := c.downloads[k]; ok && existing.active() {
		return existing.snapshot(), nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	d := &download{repoID: repoID, filename: filename, files: files, location: loc, state: "queued", startedAt: time.Now(), cancel: cancel}
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
		if d.location.Key == location && d.active() {
			return true
		}
	}
	return false
}

func (c *Catalog) Cancel(repoID, filename string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	d, ok := c.downloads[key(repoID, filename)]
	if !ok || !d.active() {
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
		if d.active() {
			n++
		}
	}
	return n
}

// totalSize asks for one byte and reads the total out of Content-Range,
// which also proves the server supports ranges at all.
func (c *Catalog) totalSize(ctx context.Context, client *http.Client, url string) (int64, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	req.Header.Set("Range", "bytes=0-0")
	c.authorize(req)
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode >= 400 {
		return 0, c.refused(resp.StatusCode)
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
	c.authorize(req)
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
	c.set(d, func() { d.state = "downloading"; d.startedAt = time.Now() })
	err := c.fetchAll(ctx, d)
	if err == nil {
		c.set(d, func() { d.done = d.total; d.state = "done"; d.current = "" })
		log.Printf("downloaded %s (%.1f GiB)", path.Join(d.repoID, d.filename), float64(d.total)/(1<<30))
		return
	}
	if errors.Is(err, context.Canceled) {
		// .part and .part.state are kept on purpose so a retry resumes.
		c.set(d, func() { d.state = "cancelled" })
		return
	}
	c.set(d, func() { d.state = "error"; d.err = err.Error() })
	log.Printf("download of %s failed: %v", path.Join(d.repoID, d.filename), err)
}

// fetchAll fetches a download's files one after another, each in parallel
// segments. A single GGUF is looked up in the listing for its digest; if
// the listing cannot be read it is fetched unchecked, as before.
func (c *Catalog) fetchAll(ctx context.Context, d *download) error {
	files := d.files
	if files == nil {
		files = []remoteFile{{Name: d.filename}}
		if listed, err := c.remoteFiles(ctx, d.repoID); err == nil {
			for _, f := range listed {
				if f.Name == d.filename {
					files[0] = f
				}
			}
		}
	} else {
		var total int64
		for _, f := range files {
			total += f.Size
		}
		c.set(d, func() { d.total = total })
	}
	client := &http.Client{Timeout: 0, Transport: &http.Transport{MaxConnsPerHost: parallel + 2,
		MaxIdleConnsPerHost: parallel, ResponseHeaderTimeout: 30 * time.Second}}
	for _, f := range files {
		target := LocalPath(d.location, d.repoID, f.Name)
		if st, err := os.Stat(target); err == nil && d.files != nil && f.Size > 0 && st.Size() == f.Size {
			c.set(d, func() { d.base += f.Size; d.done = d.base; d.resumed += f.Size; d.filesDone++ })
			continue
		}
		c.set(d, func() { d.current = f.Name })
		if err := c.fetchFile(ctx, client, d, f, target); err != nil {
			if d.files != nil && !errors.Is(err, context.Canceled) {
				return fmt.Errorf("%s：%w", f.Name, err)
			}
			return err
		}
		c.set(d, func() { d.filesDone++ })
	}
	return nil
}

// fetchFile fetches one file in parallel segments into a .part beside its
// target, checks it, and moves it into place.
func (c *Catalog) fetchFile(ctx context.Context, client *http.Client, d *download, f remoteFile, target string) error {
	url := c.Hub + "/" + d.repoID + "/resolve/main/" + f.Name
	partial := target + ".part"
	statePath := partial + ".state"
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	total, err := c.totalSize(ctx, client, url)
	if err != nil {
		return err
	}
	if total <= 0 {
		// An empty file is a real file (an __init__.py, say): made, not fetched.
		if total == 0 && d.files != nil {
			return os.WriteFile(target, nil, 0o644)
		}
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
		log.Printf("resuming %s with %d/%d segments already present", f.Name, len(done), segments)
	}
	c.set(d, func() {
		if d.files == nil {
			d.total = total
		}
		d.done = d.base + have
		d.resumed += have
	})

	file, err := os.OpenFile(partial, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()
	// Sparse until written, so preallocating costs no disk up front.
	if err := file.Truncate(total); err != nil {
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
					err = c.fetchSegment(workCtx, client, url, file, index, total, d)
					if err == nil || workCtx.Err() != nil {
						break
					}
					log.Printf("segment %d of %s failed (%v); retrying", index, f.Name, err)
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
	// And the one that proves the bytes are the right ones.
	if f.SHA256 != "" {
		c.set(d, func() { d.state = "verifying" })
		sum, err := sha256Of(ctx, partial)
		if err != nil {
			return err
		}
		if sum != f.SHA256 {
			os.Remove(partial)
			os.Remove(statePath)
			return fmt.Errorf("校驗不符（sha256 %s，應為 %s），已刪除，重新下載即可", sum[:12], f.SHA256[:12])
		}
		c.set(d, func() { d.state = "downloading" })
	}
	file.Close()
	if err := os.Rename(partial, target); err != nil {
		return err
	}
	os.Remove(statePath)
	c.set(d, func() { d.base += total; d.done = d.base })
	return nil
}

// sha256Of hashes a file, stopping when asked to.
func sha256Of(ctx context.Context, p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	buf := make([]byte, 4<<20)
	for {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		n, err := f.Read(buf)
		h.Write(buf[:n])
		if err == io.EOF {
			return hex.EncodeToString(h.Sum(nil)), nil
		}
		if err != nil {
			return "", err
		}
	}
}
