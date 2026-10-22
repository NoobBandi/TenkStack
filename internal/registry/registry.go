// Package registry asks a container registry what it holds for an image:
// the tags of its repository, and the digest a tag points at now. It is
// how the engines page says what version is installed, what else there
// is, and whether a tag that moves -- nightly, latest -- has moved since
// it was pulled. Anonymous, read-only: only public images are asked about.
package registry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Ref is an image name in its parts: the registry host, the repository
// on it, and the tag ("vllm/vllm-openai-xpu:v0.31.0" is docker.io,
// vllm/vllm-openai-xpu, v0.31.0; a bare name is under library/).
type Ref struct{ Host, Repo, Tag string }

// Parse reads an image name. A digest after @ is dropped; no tag is latest.
func Parse(image string) Ref {
	if i := strings.Index(image, "@"); i >= 0 {
		image = image[:i]
	}
	r := Ref{Host: "docker.io", Tag: "latest"}
	if i := strings.LastIndex(image, ":"); i > strings.LastIndex(image, "/") {
		image, r.Tag = image[:i], image[i+1:]
	}
	if first, rest, ok := strings.Cut(image, "/"); ok && (strings.ContainsAny(first, ".:") || first == "localhost") {
		r.Host, image = first, rest
	}
	if r.Host == "docker.io" && !strings.Contains(image, "/") {
		image = "library/" + image
	}
	r.Repo = image
	return r
}

// Name is the image as people write it: no docker.io, no library/.
func (r Ref) Name() string {
	repo := strings.TrimPrefix(r.Repo, "library/")
	if r.Host != "docker.io" {
		repo = r.Host + "/" + r.Repo
	}
	return repo + ":" + r.Tag
}

// Tag is one tag of a repository: its name, the digest it points at, and
// when it last moved -- the last two only where the registry says.
type Tag struct {
	Name    string
	Digest  string
	Updated time.Time
}

// Client asks registries. Hub is Docker Hub's web API, which unlike the
// registry protocol dates its tags.
type Client struct {
	HTTP *http.Client
	Hub  string
}

func New() *Client {
	return &Client{HTTP: &http.Client{Timeout: 20 * time.Second}, Hub: "https://hub.docker.com"}
}

// Tags is a repository's tags, newest first where the registry dates them
// (Docker Hub: the most recently moved 100), else in the registry's own
// order, at most limit.
func (c *Client) Tags(ctx context.Context, ref Ref, limit int) ([]Tag, error) {
	if ref.Host == "docker.io" {
		return c.hubTags(ctx, ref, limit)
	}
	var out []Tag
	next := fmt.Sprintf("/v2/%s/tags/list?n=1000", ref.Repo)
	for next != "" && len(out) < limit {
		resp, err := c.registry(ctx, ref, http.MethodGet, next, "")
		if err != nil {
			return nil, err
		}
		var page struct {
			Tags []string `json:"tags"`
		}
		err = json.NewDecoder(resp.Body).Decode(&page)
		resp.Body.Close()
		if err != nil {
			return nil, err
		}
		for _, t := range page.Tags {
			out = append(out, Tag{Name: t})
		}
		next = nextPage(resp.Header.Get("Link"))
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (c *Client) hubTags(ctx context.Context, ref Ref, limit int) ([]Tag, error) {
	u := fmt.Sprintf("%s/v2/repositories/%s/tags?page_size=100&ordering=last_updated", c.Hub, ref.Repo)
	var out []Tag
	for u != "" && len(out) < limit {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		resp, err := c.HTTP.Do(req)
		if err != nil {
			return nil, err
		}
		var page struct {
			Next    string `json:"next"`
			Results []struct {
				Name        string    `json:"name"`
				Digest      string    `json:"digest"`
				LastUpdated time.Time `json:"last_updated"`
			} `json:"results"`
		}
		err = decode(resp, &page)
		if err != nil {
			return nil, err
		}
		for _, r := range page.Results {
			out = append(out, Tag{Name: r.Name, Digest: r.Digest, Updated: r.LastUpdated})
		}
		u = page.Next
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// Digest is what a tag points at now: the digest docker records as the
// image's repo digest when it pulls that tag, so the two compare.
func (c *Client) Digest(ctx context.Context, ref Ref) (string, error) {
	resp, err := c.registry(ctx, ref, http.MethodHead, fmt.Sprintf("/v2/%s/manifests/%s", ref.Repo, ref.Tag), strings.Join([]string{
		"application/vnd.oci.image.index.v1+json",
		"application/vnd.docker.distribution.manifest.list.v2+json",
		"application/vnd.oci.image.manifest.v1+json",
		"application/vnd.docker.distribution.manifest.v2+json",
	}, ", "))
	if err != nil {
		return "", err
	}
	resp.Body.Close()
	d := resp.Header.Get("Docker-Content-Digest")
	if d == "" {
		return "", errors.New("the registry did not say the digest")
	}
	return d, nil
}

// registry makes a registry API request, answering the bearer challenge a
// public repository gives an anonymous client with an anonymous token.
func (c *Client) registry(ctx context.Context, ref Ref, method, path, accept string) (*http.Response, error) {
	host := ref.Host
	if host == "docker.io" {
		host = "registry-1.docker.io"
	}
	do := func(token string) (*http.Response, error) {
		req, _ := http.NewRequestWithContext(ctx, method, "https://"+host+path, nil)
		if accept != "" {
			req.Header.Set("Accept", accept)
		}
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		return c.HTTP.Do(req)
	}
	resp, err := do("")
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusUnauthorized {
		challenge := resp.Header.Get("WWW-Authenticate")
		resp.Body.Close()
		token, err := c.token(ctx, challenge, ref.Repo)
		if err != nil {
			return nil, err
		}
		if resp, err = do(token); err != nil {
			return nil, err
		}
	}
	if resp.StatusCode >= 300 {
		resp.Body.Close()
		return nil, fmt.Errorf("%s %s: %s", host, path, resp.Status)
	}
	return resp, nil
}

var challengeParam = regexp.MustCompile(`(\w+)="([^"]*)"`)

// token is an anonymous pull token for repo from the realm a 401 named.
func (c *Client) token(ctx context.Context, challenge, repo string) (string, error) {
	if !strings.HasPrefix(strings.ToLower(challenge), "bearer ") {
		return "", errors.New("the registry asks for credentials")
	}
	params := map[string]string{}
	for _, m := range challengeParam.FindAllStringSubmatch(challenge, -1) {
		params[strings.ToLower(m[1])] = m[2]
	}
	realm, err := url.Parse(params["realm"])
	if err != nil || realm.Scheme != "https" {
		return "", errors.New("the registry named no usable token service")
	}
	q := realm.Query()
	if s := params["service"]; s != "" {
		q.Set("service", s)
	}
	q.Set("scope", "repository:"+repo+":pull")
	realm.RawQuery = q.Encode()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, realm.String(), nil)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	var t struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if err := decode(resp, &t); err != nil {
		return "", err
	}
	if t.Token == "" {
		t.Token = t.AccessToken
	}
	return t.Token, nil
}

func decode(resp *http.Response, v any) error {
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		io.Copy(io.Discard, resp.Body)
		return fmt.Errorf("%s: %s", resp.Request.URL.Host, resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

var linkNext = regexp.MustCompile(`<([^>]+)>;\s*rel="next"`)

// nextPage is the path of the next page a Link header names, "" at the end.
func nextPage(link string) string {
	m := linkNext.FindStringSubmatch(link)
	if m == nil {
		return ""
	}
	if u, err := url.Parse(m[1]); err == nil {
		return u.RequestURI()
	}
	return ""
}
