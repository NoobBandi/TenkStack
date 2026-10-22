package registry

import (
	"regexp"
	"slices"
	"sort"
	"strconv"
)

// What a tag is, by how publishers name them:
//
//	release  a version, which is never moved again: v0.31.0, 0.5.4
//	build    one numbered build of a rolling tag: server-intel-b11804
//	nightly  one day's build, pinned by its commit: nightly-39983a5e…
//	rolling  a name the publisher moves to each new build: nightly,
//	         latest, server-intel
const (
	Release = "release"
	Build   = "build"
	Nightly = "nightly"
	Rolling = "rolling"
)

var (
	releaseTag = regexp.MustCompile(`^v?(\d+)\.(\d+)(?:\.(\d+))?$`)
	buildTag   = regexp.MustCompile(`^(.+)-b(\d+)$`)
	nightlyTag = regexp.MustCompile(`^(.*nightly.*)-([0-9a-f]{7,40})$`)
	// Release candidates and post-releases are versions too, but not
	// offered: they are for testing a release, not for running one.
	preRelease = regexp.MustCompile(`^v?\d+\.\d+(\.\d+)?[.-]?(rc|post|dev|a|b)\d*$`)
)

// Kind is which of the four a tag is.
func Kind(tag string) string {
	switch {
	case releaseTag.MatchString(tag) || preRelease.MatchString(tag):
		return Release
	case buildTag.MatchString(tag):
		return Build
	case nightlyTag.MatchString(tag):
		return Nightly
	}
	return Rolling
}

// Moves is whether a tag is one its publisher moves to new builds, so
// pulling it again can bring something else.
func Moves(tag string) bool { return Kind(tag) == Rolling }

// version is a release tag's numbers, ok false for anything else.
func version(tag string) ([3]int, bool) {
	m := releaseTag.FindStringSubmatch(tag)
	if m == nil {
		return [3]int{}, false
	}
	var v [3]int
	for i := range 3 {
		v[i], _ = strconv.Atoi(m[i+1])
	}
	return v, true
}

func newer(a, b [3]int) bool {
	for i := range 3 {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return false
}

// BuildOf is a build tag's rolling name and number: server-intel-b11804 is
// server-intel, 11804.
func BuildOf(tag string) (string, int, bool) {
	m := buildTag.FindStringSubmatch(tag)
	if m == nil {
		return "", 0, false
	}
	n, _ := strconv.Atoi(m[2])
	return m[1], n, true
}

// Newer are the releases among tags later than current, newest first;
// nothing when current is not a release.
func Newer(tags []Tag, current string) []Tag {
	have, ok := version(current)
	if !ok {
		return nil
	}
	var out []Tag
	for _, t := range tags {
		if v, ok := version(t.Name); ok && newer(v, have) {
			out = append(out, t)
		}
	}
	sortReleases(out)
	return out
}

func sortReleases(tags []Tag) {
	sort.SliceStable(tags, func(i, j int) bool {
		a, _ := version(tags[i].Name)
		b, _ := version(tags[j].Name)
		return newer(a, b)
	})
}

// Offered is what of a repository's tags is worth offering beside the
// ones the engine's record names (rolling): its newest releases, its
// newest nightlies pinned by commit, and the newest numbered builds of
// each rolling name in use -- each at most n, newest first. The rest
// (architecture variants, other cards' builds, release candidates) is
// left out.
func Offered(tags []Tag, rolling []string, n int) []Tag {
	var releases, nightlies []Tag
	builds := map[string][]Tag{}
	for _, t := range tags {
		switch {
		case releaseTag.MatchString(t.Name):
			releases = append(releases, t)
		case nightlyTag.MatchString(t.Name) && !t.Updated.IsZero():
			nightlies = append(nightlies, t)
		default:
			if name, _, ok := BuildOf(t.Name); ok && slices.Contains(rolling, name) {
				builds[name] = append(builds[name], t)
			}
		}
	}
	sortReleases(releases)
	sort.SliceStable(nightlies, func(i, j int) bool { return nightlies[i].Updated.After(nightlies[j].Updated) })
	out := append(first(releases, n), first(nightlies, n)...)
	for _, name := range rolling {
		b := builds[name]
		sort.SliceStable(b, func(i, j int) bool {
			_, x, _ := BuildOf(b[i].Name)
			_, y, _ := BuildOf(b[j].Name)
			return x > y
		})
		out = append(out, first(b, n)...)
	}
	return out
}

func first(tags []Tag, n int) []Tag {
	if len(tags) > n {
		return tags[:n]
	}
	return tags
}

// SameRepo is whether two image names are the same repository.
func SameRepo(a, b string) bool {
	x, y := Parse(a), Parse(b)
	return x.Host == y.Host && x.Repo == y.Repo
}
