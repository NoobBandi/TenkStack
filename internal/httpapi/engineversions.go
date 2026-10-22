package httpapi

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/NoobBandi/TenkStack/internal/api"
	"github.com/NoobBandi/TenkStack/internal/providers"
	"github.com/NoobBandi/TenkStack/internal/registry"
)

// How long a repository's tags and a tag's digest are kept: llama.cpp's
// repository lists twelve thousand tags in about ten seconds, and the
// drawer asks every time it opens.
const (
	tagsFor   = 30 * time.Minute
	digestFor = 10 * time.Minute
)

type cached[T any] struct {
	at  time.Time
	val T
	err error
}

// versionCache keeps the registries' answers, by repository and by image.
type versionCache struct {
	mu      sync.Mutex
	tags    map[string]cached[[]registry.Tag]
	digests map[string]cached[string]
}

var registryCache = &versionCache{tags: map[string]cached[[]registry.Tag]{}, digests: map[string]cached[string]{}}

func (c *versionCache) tagsOf(ctx context.Context, reg *registry.Client, ref registry.Ref) ([]registry.Tag, error) {
	key := ref.Host + "/" + ref.Repo
	c.mu.Lock()
	hit, ok := c.tags[key]
	c.mu.Unlock()
	if ok && time.Since(hit.at) < tagsFor {
		return hit.val, hit.err
	}
	// Docker Hub dates its tags, newest first: the recent ones are enough.
	// The registry protocol does neither, so the whole list it is.
	limit := 300
	if ref.Host != "docker.io" {
		limit = 50000
	}
	tags, err := reg.Tags(ctx, ref, limit)
	c.mu.Lock()
	c.tags[key] = cached[[]registry.Tag]{time.Now(), tags, err}
	c.mu.Unlock()
	return tags, err
}

func (c *versionCache) digestOf(ctx context.Context, reg *registry.Client, ref registry.Ref) (string, error) {
	key := ref.Host + "/" + ref.Repo + ":" + ref.Tag
	c.mu.Lock()
	hit, ok := c.digests[key]
	c.mu.Unlock()
	if ok && time.Since(hit.at) < digestFor {
		return hit.val, hit.err
	}
	d, err := reg.Digest(ctx, ref)
	c.mu.Lock()
	c.digests[key] = cached[string]{time.Now(), d, err}
	c.mu.Unlock()
	return d, err
}

func stamp(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// readEngineVersions answers what is installed for one build of an engine,
// whether its tag has moved, and what it could be switched to.
func (s *Server) readEngineVersions(w http.ResponseWriter, r *http.Request) {
	if !s.owner(w, r) {
		return
	}
	key, vendor := r.URL.Query().Get("provider"), r.URL.Query().Get("vendor")
	p, err := providers.Lookup(key)
	if err != nil {
		fail(w, http.StatusNotFound, err.Error())
		return
	}
	b, ok := p.Builds[vendor]
	if !ok {
		fail(w, http.StatusNotFound, p.Name+" 沒有 "+vendor+" 顯示卡的版本")
		return
	}
	ctx := r.Context()
	image := b.Image
	if s.Installer != nil {
		if st := s.Installer.State(ctx, key, vendor); st.Image != nil && b.Accepts(*st.Image) {
			image = *st.Image
		}
	}
	writeJSON(w, http.StatusOK, s.engineVersions(ctx, b, image))
}

func (s *Server) engineVersions(ctx context.Context, b providers.Build, image string) api.EngineVersions {
	ref := registry.Parse(image)
	out := api.EngineVersions{Image: image, Kind: registry.Kind(ref.Tag), Newer: []api.EngineTag{}, Tags: []api.EngineTag{}}
	localDigest := ""
	if s.Docker != nil {
		if info, ok := s.Docker.InspectImage(ctx, image); ok {
			out.Built = stamp(info.Created)
			out.Version = info.Labels["org.opencontainers.image.version"]
			for _, rd := range info.RepoDigests {
				if repo, d, ok := strings.Cut(rd, "@"); ok && registry.SameRepo(repo+":x", image) {
					localDigest = d
				}
			}
		}
	}
	// "24.04" is the base image's, not the engine's.
	if out.Version != "" && !strings.HasPrefix(out.Version, "b") {
		out.Version = ""
	}

	tag := func(t registry.Tag) api.EngineTag {
		img := registry.Ref{Host: ref.Host, Repo: ref.Repo, Tag: t.Name}.Name()
		return api.EngineTag{Image: img, Tag: t.Name, Kind: registry.Kind(t.Name), Updated: stamp(t.Updated)}
	}
	seen := map[string]bool{}
	var rolling []string
	for _, c := range b.Choices() {
		cref := registry.Parse(c.Image)
		if registry.Moves(cref.Tag) {
			rolling = append(rolling, cref.Tag)
		}
		seen[cref.Tag] = true
		out.Tags = append(out.Tags, api.EngineTag{Image: c.Image, Tag: cref.Tag, Kind: registry.Kind(cref.Tag),
			Label: c.Label, Note: c.Note, Recommended: true})
	}
	if s.Registry == nil {
		out.Error = "沒有設定映像倉庫"
		return out
	}
	tags, err := registryCache.tagsOf(ctx, s.Registry, ref)
	if err != nil {
		out.Error = "查不到映像倉庫：" + err.Error()
		return out
	}
	byName := map[string]registry.Tag{}
	for _, t := range tags {
		byName[t.Name] = t
	}
	for i := range out.Tags {
		if t, ok := byName[out.Tags[i].Tag]; ok {
			out.Tags[i].Updated = stamp(t.Updated)
		}
	}
	for _, t := range registry.Offered(tags, rolling, 6) {
		if !seen[t.Name] {
			seen[t.Name] = true
			out.Tags = append(out.Tags, tag(t))
		}
	}
	for _, t := range registry.Newer(tags, ref.Tag) {
		out.Newer = append(out.Newer, tag(t))
	}

	if out.Kind != registry.Rolling {
		return out
	}
	remote, err := registryCache.digestOf(ctx, s.Registry, ref)
	if err != nil {
		out.Error = "查不到 " + ref.Tag + " 現在的版本：" + err.Error()
		return out
	}
	out.UpToDate = localDigest != "" && remote == localDigest
	// Which build the rolling tag is now: the dated tag sharing its digest
	// (Docker Hub says digests), or the newest numbered builds, asked one
	// by one (the registry protocol does not list digests).
	var latest *registry.Tag
	for _, t := range tags {
		if t.Name != ref.Tag && t.Digest == remote && registry.Kind(t.Name) != registry.Rolling {
			t := t
			latest = &t
			break
		}
	}
	if latest == nil {
		if hub, ok := byName[ref.Tag]; ok && !hub.Updated.IsZero() {
			latest = &registry.Tag{Name: ref.Tag, Updated: hub.Updated}
		}
		for _, t := range registry.Offered(tags, []string{ref.Tag}, 3) {
			if name, _, ok := registry.BuildOf(t.Name); !ok || name != ref.Tag {
				continue
			}
			d, err := registryCache.digestOf(ctx, s.Registry, registry.Ref{Host: ref.Host, Repo: ref.Repo, Tag: t.Name})
			if err == nil && d == remote {
				t := t
				latest = &t
				break
			}
		}
	}
	if latest != nil {
		lt := tag(*latest)
		out.Latest = &lt
	}
	return out
}
