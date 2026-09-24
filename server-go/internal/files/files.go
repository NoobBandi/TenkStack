// Package files browses and fills the machine's directories. What is
// reachable is configured, not assumed: roots are declared, and a deny
// list holds however they are configured, because a console must not be
// able to hand out its own signing key.
package files

import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
)

const (
	PartSuffix   = ".part"
	ListingLimit = 3000
)

// Errors the route layer maps to statuses.
type (
	BadPath        struct{ Msg string } // outside the tree it was given: 400
	Denied         struct{ Msg string } // no configuration may expose it: 403
	Stale          struct{ Msg string } // the file moved on while edited: 409
	TooBig         struct{ Msg string } // more than an editor should hold: 413
	Exists         struct{ Name string }
	NotFound       struct{ Name string }
	NotEmpty       struct{ Name string }
	NotDir         struct{ Name string }
	NotWritable    struct{ Path string }
	UploadMismatch struct{ Msg string }
)

func (e *BadPath) Error() string        { return e.Msg }
func (e *Denied) Error() string         { return e.Msg }
func (e *Stale) Error() string          { return e.Msg }
func (e *TooBig) Error() string         { return e.Msg }
func (e *Exists) Error() string         { return e.Name + " 已存在" }
func (e *NotFound) Error() string       { return "找不到 " + e.Name }
func (e *NotEmpty) Error() string       { return "資料夾不是空的" }
func (e *NotDir) Error() string         { return e.Name + " 不是資料夾" }
func (e *NotWritable) Error() string    { return e.Path + " 不可寫入" }
func (e *UploadMismatch) Error() string { return e.Msg }

type Root struct {
	Key      string
	Label    string
	Path     string
	Note     string
	Readonly bool
	Group    string
}

type Files struct {
	ComfyDir  string
	StateDir  string
	Home      string
	Roots     string // CONSOLE_FILE_ROOTS
	ExtraDeny string // CONSOLE_FILE_DENY
	// Reclaim gives a directory the ComfyUI container wrote back to the
	// console's user, recursively. Nil where there is no container side.
	Reclaim func(dir string) error
	// ModelRoots is the model locations llama.cpp and vLLM load from, each
	// offered as a root of its own.
	ModelRoots func() []ModelRoot
}

// ModelRoot is one model location as the file page needs it.
type ModelRoot struct {
	Key, Label, Path string
	Primary          bool
}

func resolveQuiet(p string) string {
	if real, err := filepath.EvalSymlinks(p); err == nil {
		return real
	}
	return filepath.Clean(p)
}

// deny is the list of paths that stay unreachable however the roots are
// configured: the console's own state first, then the credentials a
// machine like this accumulates.
func (f *Files) deny() []string {
	candidates := []string{f.StateDir}
	for _, rel := range []string{".ssh", ".gnupg", ".aws", ".docker", ".kube", ".config/gh", ".config/gcloud", ".local/share/keyrings"} {
		candidates = append(candidates, filepath.Join(f.Home, rel))
	}
	for _, p := range strings.Split(f.ExtraDeny, ":") {
		if p = strings.TrimSpace(p); p != "" {
			if strings.HasPrefix(p, "~/") {
				p = filepath.Join(f.Home, p[2:])
			}
			candidates = append(candidates, p)
		}
	}
	out := make([]string, 0, len(candidates))
	for _, c := range candidates {
		out = append(out, resolveQuiet(c))
	}
	return out
}

func under(p string, banned []string) bool {
	for _, b := range banned {
		if p == b || strings.HasPrefix(p, b+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// modelRoots are the model locations, keyed llm-<macro> so they can never
// collide with a ComfyUI root.
func (f *Files) modelRoots() []Root {
	if f.ModelRoots == nil {
		return nil
	}
	var out []Root
	for _, loc := range f.ModelRoots() {
		label := loc.Label
		if label == "" {
			label = loc.Path
			if loc.Primary {
				label = "主要位置"
			}
		}
		out = append(out, Root{"llm-" + loc.Key, label, loc.Path,
			"llama.cpp 與 vLLM 的模型，" + loc.Path + "。", false, "llm"})
	}
	return out
}

func (f *Files) comfyRoots() []Root {
	roots := []Root{
		{"models", "模型", filepath.Join(f.ComfyDir, "storage-models/models"), "checkpoints、loras、vae 等等。所有 ComfyUI 實例共用這一份。", false, "comfy"},
		{"input", "輸入", filepath.Join(f.ComfyDir, "storage-user/input"), "工作流讀得到的圖片與素材，所有實例共用。", false, "comfy"},
	}
	// Outputs are per instance, found rather than configured, newest first.
	matches, _ := filepath.Glob(filepath.Join(f.ComfyDir, "storage-user", "output-*"))
	type found struct {
		path    string
		written int64
	}
	var outputs []found
	for _, m := range matches {
		st, err := os.Stat(m)
		if err != nil || !st.IsDir() {
			continue
		}
		outputs = append(outputs, found{m, st.ModTime().UnixNano()})
	}
	sort.SliceStable(outputs, func(i, j int) bool { return outputs[i].written > outputs[j].written })
	for _, o := range outputs {
		slot := strings.TrimPrefix(filepath.Base(o.path), "output-")
		label := "輸出"
		if len(outputs) > 1 {
			label = "輸出 " + slot
		}
		roots = append(roots, Root{"output-" + slot, label, o.path, "comfyui-" + slot + " 寫出來的成品。每個實例一份，不共用。", false, "comfy"})
	}
	return roots
}

// configuredRoots parses CONSOLE_FILE_ROOTS: `label=path` entries joined by
// `;`, an optional `ro:` in front of a path. Setting it replaces the
// defaults; the ComfyUI trees are still appended.
func (f *Files) configuredRoots() []Root {
	raw := strings.TrimSpace(f.Roots)
	if raw == "" {
		return nil
	}
	var out []Root
	for index, chunk := range strings.Split(raw, ";") {
		chunk = strings.TrimSpace(chunk)
		if chunk == "" {
			continue
		}
		label, spec, ok := strings.Cut(chunk, "=")
		if !ok {
			label, spec = "", chunk
		}
		spec = strings.TrimSpace(spec)
		readonly := strings.HasPrefix(spec, "ro:")
		spec = strings.TrimPrefix(spec, "ro:")
		if strings.HasPrefix(spec, "~/") {
			spec = filepath.Join(f.Home, spec[2:])
		} else if spec == "~" {
			spec = f.Home
		}
		label = strings.TrimSpace(label)
		if label == "" {
			label = filepath.Base(spec)
			if label == "/" || label == "." {
				label = spec
			}
		}
		out = append(out, Root{fmt.Sprintf("fs%d", index), label, spec, spec, readonly, "other"})
	}
	return out
}

func (f *Files) defaultRoots() []Root {
	out := []Root{{"home", "家目錄", f.Home, f.Home, false, "other"}}
	for _, mount := range []string{"/mnt", "/media"} {
		entries, err := os.ReadDir(mount)
		if err == nil && len(entries) > 0 {
			out = append(out, Root{filepath.Base(mount), mount, mount, "掛載在 " + mount + " 底下的磁碟", false, "other"})
		}
	}
	return out
}

func (f *Files) roots() []Root {
	wide := f.configuredRoots()
	if wide == nil {
		wide = f.defaultRoots()
	}
	return append(append(f.modelRoots(), f.comfyRoots()...), wide...)
}

func (f *Files) root(key string) (Root, error) {
	for _, r := range f.roots() {
		if r.Key == key {
			return r, nil
		}
	}
	return Root{}, &BadPath{"unknown root: " + key}
}

var safeSegment = regexp.MustCompile(`^[^/\\\x00]{1,255}$`)

func checkSegment(segment string) error {
	if !safeSegment.MatchString(segment) || segment == "." || segment == ".." {
		return &BadPath{fmt.Sprintf("bad name: '%s'", segment)}
	}
	return nil
}

// Resolve is the absolute path for a directory, or an entry inside it,
// checked on the resolved path since only that form accounts for symlinks.
func (f *Files) Resolve(rootKey, rel, name string) (string, error) {
	root, err := f.root(rootKey)
	if err != nil {
		return "", err
	}
	target := root.Path
	for _, segment := range strings.Split(rel, "/") {
		if segment == "" {
			continue
		}
		if err := checkSegment(segment); err != nil {
			return "", err
		}
		target = filepath.Join(target, segment)
	}
	if name != "" {
		if err := checkSegment(name); err != nil {
			return "", err
		}
		target = filepath.Join(target, name)
	}
	base := resolveQuiet(root.Path)
	final := resolveAsFarAsExists(target)
	if final != base && !strings.HasPrefix(final, base+string(filepath.Separator)) {
		return "", &BadPath{"path escapes its root"}
	}
	if under(final, f.deny()) {
		return "", &Denied{"這個位置主控台不提供存取"}
	}
	return final, nil
}

// resolveAsFarAsExists follows symlinks on the part of a path that exists
// and keeps the rest as written, like Python's non-strict resolve().
func resolveAsFarAsExists(p string) string {
	p = filepath.Clean(p)
	if real, err := filepath.EvalSymlinks(p); err == nil {
		return real
	}
	dir, base := filepath.Split(p)
	dir = filepath.Clean(dir)
	if dir == p {
		return p
	}
	return filepath.Join(resolveAsFarAsExists(dir), base)
}

// Locate maps a typed absolute path to a root and a place inside it; the
// longest matching root wins, and a file answers as its directory plus name.
func (f *Files) Locate(raw string) (api.FSLocate, error) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return api.FSLocate{}, &BadPath{"要一個路徑"}
	}
	if text == "~" || strings.HasPrefix(text, "~/") {
		text = filepath.Join(f.Home, strings.TrimPrefix(text, "~"))
	}
	if !filepath.IsAbs(text) {
		return api.FSLocate{}, &BadPath{"要絕對路徑，例如 ~/tenkstack"}
	}
	final := resolveAsFarAsExists(text)
	st, err := os.Stat(final)
	if err != nil {
		return api.FSLocate{}, &NotFound{text}
	}
	if under(final, f.deny()) {
		return api.FSLocate{}, &Denied{"這個位置主控台不提供存取"}
	}
	dir, name := final, ""
	if !st.IsDir() {
		dir, name = filepath.Dir(final), filepath.Base(final)
	}
	bestDepth, bestKey, bestRel := -1, "", ""
	for _, r := range f.roots() {
		base := resolveQuiet(r.Path)
		var rel string
		switch {
		case dir == base:
			rel = ""
		case strings.HasPrefix(dir, base+string(filepath.Separator)):
			rel = strings.TrimPrefix(dir, base+string(filepath.Separator))
		default:
			continue
		}
		depth := len(strings.Split(strings.Trim(base, "/"), "/"))
		if base == "/" {
			depth = 1
		} else {
			depth++
		}
		if depth > bestDepth {
			bestDepth, bestKey, bestRel = depth, r.Key, rel
		}
	}
	if bestDepth < 0 {
		return api.FSLocate{}, &BadPath{final + " 不在任何一個開放的根目錄底下"}
	}
	return api.FSLocate{Root: bestKey, Path: bestRel, Name: name}, nil
}

func writable(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir() && syscall.Access(p, 0x2|0x1) == nil
}

func (f *Files) canWrite(root Root, p string) bool {
	return !root.Readonly && (writable(p) || f.reclaimable(p))
}

// reclaimable is a directory ComfyUI wrote that the console can take back:
// anything inside the ComfyUI storage, where the container runs as root.
func (f *Files) reclaimable(p string) bool {
	if f.Reclaim == nil || f.ComfyDir == "" {
		return false
	}
	if st, err := os.Stat(p); err != nil || !st.IsDir() {
		return false
	}
	return strings.HasPrefix(resolveQuiet(p), resolveQuiet(f.ComfyDir)+string(filepath.Separator))
}

// ensureWritable is writable, first taking back a directory ComfyUI wrote
// when its owner is what stands in the way.
func (f *Files) ensureWritable(p string) bool {
	if writable(p) {
		return true
	}
	if !f.reclaimable(p) {
		return false
	}
	if err := f.Reclaim(p); err != nil {
		log.Printf("could not take back %s from the ComfyUI container: %v", p, err)
		return false
	}
	return writable(p)
}

// reclaimed runs op, and once more after taking dir back when it failed on
// a permission: a directory moved or removed whole needs every level under
// it writable, not just the one checked up front.
func (f *Files) reclaimed(dir string, op func() error) error {
	err := op()
	if errors.Is(err, fs.ErrPermission) && f.reclaimable(dir) {
		if rerr := f.Reclaim(dir); rerr != nil {
			log.Printf("could not take back %s from the ComfyUI container: %v", dir, rerr)
			return err
		}
		err = op()
	}
	return err
}

// RootsInfo is the trees on offer, each with whether it can be written to:
// the ComfyUI directories are created by a root container.
func (f *Files) RootsInfo() []api.FSRoot {
	out := []api.FSRoot{}
	for _, r := range f.roots() {
		st, err := os.Stat(r.Path)
		exists := err == nil && st.IsDir()
		out = append(out, api.FSRoot{Key: r.Key, Label: r.Label, Note: r.Note, Path: r.Path, Exists: exists,
			Writable: exists && f.canWrite(r, r.Path), Group: r.Group})
	}
	return out
}

// FreeBytes is the room left on the filesystem holding this location.
func FreeBytes(p string) int64 {
	for {
		if _, err := os.Stat(p); err == nil || p == filepath.Dir(p) {
			break
		}
		p = filepath.Dir(p)
	}
	var st syscall.Statfs_t
	if err := syscall.Statfs(p, &st); err != nil {
		return 0
	}
	return int64(st.Bavail) * int64(st.Bsize)
}

func mtime(st os.FileInfo) float64 {
	return float64(st.ModTime().Unix()) + float64(st.ModTime().Nanosecond())*1e-9
}

// Listing is everything at one location in a single directory read. A
// .part is listed as the file it will become, marked incomplete; what is
// neither file nor directory is listed as other; a stat failure lists what
// is known.
func (f *Files) Listing(rootKey, rel string, hidden bool, query string, limit int) (api.FSListing, error) {
	here, err := f.Resolve(rootKey, rel, "")
	if err != nil {
		return api.FSListing{}, err
	}
	root, _ := f.root(rootKey)
	if st, err := os.Stat(here); err != nil || !st.IsDir() {
		return api.FSListing{Entries: []map[string]any{}, Writable: false, Free: 0}, nil
	}
	denied := f.deny()
	needle := strings.ToLower(strings.TrimSpace(query))
	dirEntries, err := os.ReadDir(here)
	if err != nil {
		return api.FSListing{}, &NotWritable{here}
	}
	entries := []map[string]any{}
	for _, e := range dirEntries {
		name := e.Name()
		isHidden := strings.HasPrefix(name, ".")
		if isHidden && !hidden {
			continue
		}
		if needle != "" && !strings.Contains(strings.ToLower(name), needle) {
			continue
		}
		full := filepath.Join(here, name)
		resolved := full
		if e.Type()&os.ModeSymlink != 0 {
			if real, err := filepath.EvalSymlinks(full); err == nil {
				resolved = real
			}
		}
		if under(resolved, denied) {
			continue
		}
		st, err := os.Stat(full)
		if err != nil {
			entries = append(entries, map[string]any{"name": name, "kind": "other", "size": 0, "modified": 0, "partial": false, "hidden": isHidden})
			continue
		}
		kind := "other"
		switch {
		case st.IsDir():
			kind = "dir"
		case st.Mode().IsRegular():
			kind = "file"
		}
		partial := kind == "file" && strings.HasSuffix(name, PartSuffix)
		shown := name
		if partial {
			shown = strings.TrimSuffix(name, PartSuffix)
		}
		entry := map[string]any{"name": shown, "kind": kind, "media": nil, "size": nil, "modified": mtime(st), "partial": partial, "hidden": isHidden}
		if kind == "file" {
			entry["media"] = MediaKind(shown)
		}
		if kind != "dir" {
			entry["size"] = st.Size()
		}
		entries = append(entries, entry)
	}
	sort.SliceStable(entries, func(i, j int) bool {
		di, dj := entries[i]["kind"] != "dir", entries[j]["kind"] != "dir"
		if di != dj {
			return !di
		}
		return strings.ToLower(entries[i]["name"].(string)) < strings.ToLower(entries[j]["name"].(string))
	})
	total := len(entries)
	if len(entries) > limit {
		entries = entries[:limit]
	}
	truncated := total > limit
	readonly := root.Readonly
	return api.FSListing{Entries: entries, Total: total, Truncated: &truncated, Writable: f.canWrite(root, here),
		Free: FreeBytes(here), ReadonlyRoot: &readonly}, nil
}

// TreeSize walks one directory on request: the expensive question, asked
// one at a time.
func (f *Files) TreeSize(rootKey, rel, name string) (api.FSTreeSize, error) {
	here, err := f.Resolve(rootKey, rel, name)
	if err != nil {
		return api.FSTreeSize{}, err
	}
	st, err := os.Stat(here)
	if err != nil || !st.IsDir() {
		if err == nil && st.Mode().IsRegular() {
			return api.FSTreeSize{Bytes: st.Size()}, nil
		}
		return api.FSTreeSize{}, nil
	}
	var files int
	var total int64
	stack := []string{here}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		entries, err := os.ReadDir(cur)
		if err != nil {
			continue
		}
		for _, e := range entries {
			info, err := e.Info() // lstat: symlinks are not followed
			if err != nil {
				continue
			}
			switch {
			case info.IsDir():
				stack = append(stack, filepath.Join(cur, e.Name()))
			case info.Mode().IsRegular():
				files++
				total += info.Size()
			}
		}
	}
	return api.FSTreeSize{Files: files, Bytes: total}, nil
}

func (f *Files) refuseReadonly(rootKey string) error {
	root, err := f.root(rootKey)
	if err != nil {
		return err
	}
	if root.Readonly {
		return &NotWritable{"這個根目錄設定為唯讀"}
	}
	return nil
}

func exists(p string) bool { _, err := os.Lstat(p); return err == nil }

func (f *Files) Mkdir(rootKey, rel, name string) (api.FSNamed, error) {
	target, err := f.Resolve(rootKey, rel, name)
	if err != nil {
		return api.FSNamed{}, err
	}
	if err := f.refuseReadonly(rootKey); err != nil {
		return api.FSNamed{}, err
	}
	if exists(target) {
		return api.FSNamed{}, &Exists{name}
	}
	if !f.ensureWritable(filepath.Dir(target)) {
		return api.FSNamed{}, &NotWritable{filepath.Dir(target)}
	}
	if err := os.Mkdir(target, 0o755); err != nil {
		return api.FSNamed{}, err
	}
	return api.FSNamed{OK: true, Name: name}, nil
}

// Rename is a new name in the same directory; moving between directories
// is Move, which crosses a root boundary check.
func (f *Files) Rename(rootKey, rel, name, to string) (api.FSNamed, error) {
	if err := f.refuseReadonly(rootKey); err != nil {
		return api.FSNamed{}, err
	}
	source, err := f.Resolve(rootKey, rel, name)
	if err != nil {
		return api.FSNamed{}, err
	}
	target, err := f.Resolve(rootKey, rel, to)
	if err != nil {
		return api.FSNamed{}, err
	}
	if !exists(source) {
		return api.FSNamed{}, &NotFound{name}
	}
	if exists(target) {
		return api.FSNamed{}, &Exists{to}
	}
	if !f.ensureWritable(filepath.Dir(source)) {
		return api.FSNamed{}, &NotWritable{filepath.Dir(source)}
	}
	if err := f.reclaimed(source, func() error { return os.Rename(source, target) }); err != nil {
		return api.FSNamed{}, err
	}
	return api.FSNamed{OK: true, Name: to}, nil
}

// Move puts an entry into another directory, possibly under another root,
// copying when the rename cannot cross filesystems.
func (f *Files) Move(rootKey, rel, name, toRoot, toRel string) (api.FSNamed, error) {
	if err := f.refuseReadonly(rootKey); err != nil {
		return api.FSNamed{}, err
	}
	if err := f.refuseReadonly(toRoot); err != nil {
		return api.FSNamed{}, err
	}
	source, err := f.Resolve(rootKey, rel, name)
	if err != nil {
		return api.FSNamed{}, err
	}
	dest, err := f.Resolve(toRoot, toRel, "")
	if err != nil {
		return api.FSNamed{}, err
	}
	if !exists(source) {
		return api.FSNamed{}, &NotFound{name}
	}
	if st, err := os.Stat(dest); err != nil || !st.IsDir() {
		return api.FSNamed{}, &NotDir{toRel}
	}
	if !f.ensureWritable(dest) {
		return api.FSNamed{}, &NotWritable{dest}
	}
	if !f.ensureWritable(filepath.Dir(source)) {
		return api.FSNamed{}, &NotWritable{filepath.Dir(source)}
	}
	target := filepath.Join(dest, filepath.Base(source))
	if exists(target) {
		return api.FSNamed{}, &Exists{filepath.Base(source)}
	}
	if source == dest || strings.HasPrefix(dest, source+string(filepath.Separator)) {
		return api.FSNamed{}, &BadPath{"不能把資料夾移進它自己底下"}
	}
	if err := f.reclaimed(source, func() error { return os.Rename(source, target) }); err != nil {
		var linkErr *os.LinkError
		if errors.As(err, &linkErr) && errors.Is(linkErr.Err, syscall.EXDEV) {
			if err := copyTree(source, target); err != nil {
				return api.FSNamed{}, err
			}
			if err := f.reclaimed(source, func() error { return os.RemoveAll(source) }); err != nil {
				return api.FSNamed{}, err
			}
		} else {
			return api.FSNamed{}, err
		}
	}
	return api.FSNamed{OK: true, Name: filepath.Base(source)}, nil
}

func copyTree(src, dst string) error {
	st, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if st.IsDir() {
		if err := os.MkdirAll(dst, st.Mode().Perm()); err != nil {
			return err
		}
		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if err := copyTree(filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, st.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := out.ReadFrom(in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// Delete removes a file, or an empty directory only: recursively deleting
// a directory of models from a web page is a bigger promise than this.
func (f *Files) Delete(rootKey, rel, name string, partial bool) (api.FSFreed, error) {
	if err := f.refuseReadonly(rootKey); err != nil {
		return api.FSFreed{}, err
	}
	target, err := f.Resolve(rootKey, rel, name)
	if err != nil {
		return api.FSFreed{}, err
	}
	if partial {
		target += PartSuffix
	}
	if exists(target) && !f.ensureWritable(filepath.Dir(target)) {
		return api.FSFreed{}, &NotWritable{filepath.Dir(target)}
	}
	if st, err := os.Stat(target); err == nil && st.IsDir() {
		if err := os.Remove(target); err != nil {
			return api.FSFreed{}, &NotEmpty{name}
		}
		return api.FSFreed{OK: true}, nil
	}
	st, err := os.Lstat(target)
	if err != nil {
		return api.FSFreed{}, &NotFound{name}
	}
	var size int64
	if st.Mode().IsRegular() {
		size = st.Size()
	}
	if err := os.Remove(target); err != nil {
		return api.FSFreed{}, err
	}
	if strings.HasSuffix(target, PartSuffix) {
		// A download's resume ledger outlives its meaning the moment the
		// file goes.
		os.Remove(target + ".state")
	}
	return api.FSFreed{OK: true, Freed: size}, nil
}

// UploadOffset is how much of this file the server already holds.
func (f *Files) UploadOffset(rootKey, rel, name string) (api.FSOffset, error) {
	target, err := f.Resolve(rootKey, rel, name)
	if err != nil {
		return api.FSOffset{}, err
	}
	if st, err := os.Stat(target); err == nil {
		return api.FSOffset{Offset: 0, Exists: true, Size: st.Size()}, nil
	}
	if st, err := os.Stat(target + PartSuffix); err == nil {
		return api.FSOffset{Offset: st.Size()}, nil
	}
	return api.FSOffset{}, nil
}

// OpenFile is the path and length of something safe to send: regular
// files only, since /dev/zero is reachable from a root of /.
func (f *Files) OpenFile(rootKey, rel, name string, partial bool) (string, int64, error) {
	target, err := f.Resolve(rootKey, rel, name)
	if err != nil {
		return "", 0, err
	}
	if partial {
		target += PartSuffix
	}
	st, err := os.Stat(target)
	if err != nil || !st.Mode().IsRegular() {
		return "", 0, &NotFound{name}
	}
	return target, st.Size(), nil
}

// Suffix is Python's Path.suffix: a name that is only a leading dot has
// none, so .gitignore reads as no extension.
func Suffix(name string) string {
	base := filepath.Base(name)
	i := strings.LastIndex(base, ".")
	if i <= 0 {
		return ""
	}
	return strings.ToLower(base[i:])
}
