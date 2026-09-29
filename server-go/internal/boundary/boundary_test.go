// Package boundary checks the import direction between internal packages.
// Handlers call domain packages; domain packages call only the shared
// leaves. A package missing from the table fails the test until it is added.
package boundary

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const module = "github.com/NoobBandi/TenkStack/server-go/internal/"

var allowed = map[string][]string{
	// Leaves: shared by everything, importing nothing.
	"api":     {},
	"paths":   {},
	"ports":   {},
	"store":   {},
	"vendors": {},
	"webdist": {},
	// How model locations and the files in them are named.
	"locations": {},
	// What a Hugging Face model's config.json says about it.
	"hfmodel": {},
	// The owner's Hugging Face access token.
	"hftoken": {},
	// Data about software rather than cards; a leaf like vendors, and it
	// may name vendors because a build is per vendor.
	"providers": {"api", "vendors"},

	// Domain packages: only the leaves, never each other.
	"auth":             {"api"},
	"users":            {"api"},
	"settings":         {"api"},
	"system":           {"api"},
	"gpu":              {"api"},
	"gpuhistory":       {"api"},
	"journal":          {"api"},
	"activity":         {"api"},
	"llamaswap":        {"api", "providers", "locations", "hfmodel"},
	"containers":       {"api", "vendors"},
	"containerhistory": {"api"},
	"backends":         {"api", "vendors", "providers"},
	"flags":            {"api"},
	"gguf":             {},
	"channels":         {"api"},
	"blobs":            {},
	"chats":            {"api"},
	"images":           {},
	"visioncache":      {},
	"search":           {"api"},
	"catalog":          {"api", "locations", "hfmodel"},
	"files":            {"api"},
	"comfy":            {"api", "vendors"},
	"network":          {"api"},
	"versions":         {"api"},
	"release":          {"api"},
	"quant":            {"api", "vendors", "providers"},
	// The installer's screens and its provisioning; it talks to a running
	// console over HTTP, never through the console's own packages.
	"setup": {"providers"},

	// The HTTP surface may reach every domain package.
	"httpapi": {"api", "paths", "locations", "ports", "vendors", "providers", "auth", "users", "settings", "system", "gpu", "gpuhistory",
		"journal", "activity", "llamaswap", "hftoken", "containers", "containerhistory", "backends", "flags", "gguf", "channels", "network", "versions", "comfy", "blobs", "chats", "images", "visioncache", "search", "catalog", "files", "release", "quant"},
	"boundary": {},
}

func TestImportDirection(t *testing.T) {
	root, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	err = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		pkg := strings.SplitN(filepath.ToSlash(rel), "/", 2)[0]
		deps, ok := allowed[pkg]
		if !ok {
			t.Errorf("%s: package %q is not in the boundary table", rel, pkg)
			return nil
		}
		f, err := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, imp := range f.Imports {
			p := strings.Trim(imp.Path.Value, `"`)
			if !strings.HasPrefix(p, module) {
				continue
			}
			dep := strings.SplitN(strings.TrimPrefix(p, module), "/", 2)[0]
			if dep != pkg && !slices.Contains(deps, dep) {
				t.Errorf("%s: %s may not import %s", rel, pkg, dep)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
