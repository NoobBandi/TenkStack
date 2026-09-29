package llamaswap

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"

	"github.com/NoobBandi/TenkStack/internal/api"
	"github.com/NoobBandi/TenkStack/internal/locations"
)

// Models can live in more than one directory: a second disk for the large
// ones, or GGUF for llama.cpp in one place and safetensors for vLLM in
// another. How a location and a file in it are named is package locations;
// this is where they are read from and written to.
//
// The paths are the macros and nothing else, so a location added by hand
// in config.yaml is one the console knows. What is only the console's --
// a location's label, which location each format downloads to -- is kept
// in a small file of its own.

// The names the rest of this package uses for the shared ones.
const (
	PrimaryLocation = locations.Primary
	MaxLocations    = locations.Max
)

var (
	Formats    = locations.Formats
	refPattern = locations.Pattern
	Ref        = locations.Ref
	SplitRef   = locations.Split
	cmdPath    = locations.CmdPath
)

// Location is one model directory, by the macro that names it.
type Location = locations.Location

// Locations is every model location: the primary first, then the others in
// key order.
func (m *Models) Locations() []Location {
	out := []Location{{Key: PrimaryLocation, Path: m.Dir}}
	c, err := m.Store.Load()
	if err != nil {
		return out
	}
	macros := c.Root().Map("macros")
	if macros == nil {
		return out
	}
	for _, key := range locations.Keys()[1:] {
		if v := strings.TrimSpace(Scalar(macros.Get(key))); v != "" {
			out = append(out, Location{Key: key, Path: v})
		}
	}
	return out
}

func (m *Models) location(key string) (Location, bool) {
	for _, loc := range m.Locations() {
		if loc.Key == key {
			return loc, true
		}
	}
	return Location{}, false
}

// Place is where a name is on disk and the root of its location, or ok
// false when the location is unknown or the path escapes it.
func (m *Models) Place(ref string) (abs, root string, ok bool) {
	key, rel := SplitRef(ref)
	loc, found := m.location(key)
	if !found {
		return "", "", false
	}
	root = realDir(loc.Path)
	abs = within(root, rel)
	return abs, root, abs != ""
}

func realDir(p string) string {
	base, err := filepath.Abs(p)
	if err != nil {
		return filepath.Clean(p)
	}
	if real, err := filepath.EvalSymlinks(base); err == nil {
		return real
	}
	return base
}

// within is root/rel, or "" if that escapes root. Checked on the resolved
// path, since two repos may publish the same name.
func within(root, rel string) string {
	candidate := filepath.Clean(filepath.Join(root, rel))
	if real, err := filepath.EvalSymlinks(candidate); err == nil {
		candidate = real
	}
	if candidate != root && !strings.HasPrefix(candidate, root+string(filepath.Separator)) {
		return ""
	}
	return candidate
}

// rootOf is the resolved root of the location p is in, or "".
func (m *Models) rootOf(p string) string {
	best := ""
	for _, loc := range m.Locations() {
		root := realDir(loc.Path)
		if (p == root || strings.HasPrefix(p, root+string(filepath.Separator))) && len(root) > len(best) {
			best = root
		}
	}
	return best
}

// locationPrefs is the console's own half of the locations.
type locationPrefs struct {
	Labels   map[string]string `json:"labels,omitempty"`
	Defaults map[string]string `json:"defaults,omitempty"`
}

func (m *Models) prefs() locationPrefs {
	p := locationPrefs{}
	if m.Prefs != "" {
		if raw, err := os.ReadFile(m.Prefs); err == nil {
			json.Unmarshal(raw, &p)
		}
	}
	if p.Labels == nil {
		p.Labels = map[string]string{}
	}
	if p.Defaults == nil {
		p.Defaults = map[string]string{}
	}
	return p
}

func (m *Models) savePrefs(p locationPrefs) error {
	if m.Prefs == "" {
		return fmt.Errorf("no place to keep the location settings")
	}
	raw, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(m.Prefs), 0o755); err != nil {
		return err
	}
	tmp := m.Prefs + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, m.Prefs)
}

// DefaultLocation is where a new download of format lands: the location
// chosen for it, or the primary when none was or the chosen one is gone.
func (m *Models) DefaultLocation(format string) Location {
	locs := m.Locations()
	if key := m.prefs().Defaults[format]; key != "" {
		for _, loc := range locs {
			if loc.Key == key {
				return loc
			}
		}
	}
	return locs[0]
}

// mountList is the file beside the launcher scripts that names every
// location, which a container launcher reads to mount them all.
func (m *Models) mountList() string {
	return filepath.Join(filepath.Dir(m.Store.Path), "model-locations")
}

// WriteMountList rewrites that file when it differs.
func (m *Models) WriteMountList() error {
	var lines []string
	for _, loc := range m.Locations() {
		lines = append(lines, loc.Path)
	}
	text := strings.Join(lines, "\n") + "\n"
	path := m.mountList()
	if current, err := os.ReadFile(path); err == nil && string(current) == text {
		return nil
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(text), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// usesLocation says whether a cmd loads anything from key.
func usesLocation(cmd, key string) bool {
	for _, name := range weightsInCmd(cmd) {
		if k, _ := SplitRef(name); k == key {
			return true
		}
	}
	return false
}

// ListLocationLabels is each location's key and label, without the disk
// walk ListLocations does for its counts.
func (m *Models) ListLocationLabels() [][2]string {
	prefs := m.prefs()
	var out [][2]string
	for _, loc := range m.Locations() {
		out = append(out, [2]string{loc.Key, prefs.Labels[loc.Key]})
	}
	return out
}

// ListLocations is every location with what the settings page shows of it.
func (m *Models) ListLocations() api.ModelLocations {
	prefs := m.prefs()
	entries, _, _ := m.entries()
	weights := m.ListWeights()
	defaults := map[string][]string{}
	for _, format := range Formats {
		loc := m.DefaultLocation(format)
		defaults[loc.Key] = append(defaults[loc.Key], format)
	}
	out := api.ModelLocations{Locations: []api.ModelLocation{}, Max: MaxLocations}
	for _, loc := range m.Locations() {
		row := api.ModelLocation{Key: loc.Key, Path: loc.Path, Label: prefs.Labels[loc.Key],
			Primary: loc.Key == PrimaryLocation, DefaultFor: defaults[loc.Key], InUse: []string{}}
		if row.DefaultFor == nil {
			row.DefaultFor = []string{}
		}
		if st, err := os.Stat(loc.Path); err == nil && st.IsDir() {
			row.Exists = true
			row.Writable = syscall.Access(loc.Path, 0x2|0x1) == nil
			var fs syscall.Statfs_t
			if syscall.Statfs(loc.Path, &fs) == nil {
				row.FreeBytes = int64(fs.Bavail) * int64(fs.Bsize)
				row.TotalBytes = int64(fs.Blocks) * int64(fs.Bsize)
			}
		}
		for _, w := range weights {
			if w.Location == loc.Key && w.Role != "projector" {
				row.Models++
			}
			if w.Location == loc.Key {
				row.UsedBytes += w.SizeBytes
			}
		}
		for _, e := range entries {
			if usesLocation(e.cmd, loc.Key) {
				row.InUse = append(row.InUse, e.id)
			}
		}
		sort.Strings(row.InUse)
		out.Locations = append(out.Locations, row)
	}
	return out
}

// Refused-style errors for the settings page, each a sentence the page
// shows as it is.

// systemDirs are never a model location: the system's own, and /tmp,
// which a reboot empties.
var systemDirs = []string{"/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32",
	"/proc", "/run", "/sbin", "/sys", "/tmp", "/usr", "/var"}

// A location's path goes into a cmd, which llama-swap splits on
// whitespace, and into docker's -v, which splits on colons.
var unsafePath = regexp.MustCompile("[\\s:$\\{\\}'\"`\\\\;&|<>*?]")

// checkPath is the directory raw names, created when it does not exist
// yet, if it may be a location: except is the key of the location it would
// replace, which it may of course overlap.
func (m *Models) checkPath(raw, except string) (string, error) {
	p := strings.TrimSpace(raw)
	if strings.HasPrefix(p, "~/") || p == "~" {
		if home, err := os.UserHomeDir(); err == nil {
			p = filepath.Join(home, strings.TrimPrefix(p, "~"))
		}
	}
	if p == "" || !filepath.IsAbs(p) {
		return "", &Refused{"請填完整路徑，例如 /mnt/data/models"}
	}
	p = filepath.Clean(p)
	if unsafePath.MatchString(p) {
		return "", &Refused{"路徑不能有空白或 : $ { } 引號等符號，模型指令與容器掛載會被拆開"}
	}
	if p == "/" {
		return "", &Refused{"不能用根目錄"}
	}
	for _, dir := range systemDirs {
		if p == dir || strings.HasPrefix(p, dir+"/") {
			return "", &Refused{dir + " 是系統目錄，不能放模型"}
		}
	}
	if err := os.MkdirAll(p, 0o755); err != nil {
		return "", &Refused{"無法建立這個資料夾：" + err.Error()}
	}
	real := realDir(p)
	if st, err := os.Stat(real); err != nil || !st.IsDir() {
		return "", &Refused{"這不是資料夾"}
	}
	if syscall.Access(real, 0x2|0x1) != nil {
		return "", &Refused{"主控台沒有這個資料夾的寫入權限"}
	}
	for _, avoid := range m.Avoid {
		a := realDir(avoid)
		if real == a || strings.HasPrefix(real, a+"/") || strings.HasPrefix(a, real+"/") {
			return "", &Refused{"不能跟 " + avoid + " 重疊"}
		}
	}
	for _, loc := range m.Locations() {
		if loc.Key == except {
			continue
		}
		other := realDir(loc.Path)
		if real == other {
			return "", &Refused{"這個位置已經在清單裡"}
		}
		if strings.HasPrefix(real, other+"/") || strings.HasPrefix(other, real+"/") {
			return "", &Refused{"不能跟 " + loc.Path + " 互相包含，同一個模型會被算成兩份"}
		}
	}
	return real, nil
}

// AddLocation checks a directory, creating it when it does not exist yet,
// and makes it a location under the next free key.
func (m *Models) AddLocation(ctx context.Context, raw, label string) (api.ModelLocation, error) {
	locs := m.Locations()
	if len(locs) >= MaxLocations {
		return api.ModelLocation{}, &Refused{fmt.Sprintf("最多 %d 個位置", MaxLocations)}
	}
	real, err := m.checkPath(raw, "")
	if err != nil {
		return api.ModelLocation{}, err
	}
	key := ""
	taken := map[string]bool{}
	for _, loc := range locs {
		taken[loc.Key] = true
	}
	for _, k := range locations.Keys()[1:] {
		if !taken[k] {
			key = k
			break
		}
	}
	if err := m.Store.AddMacro(ctx, key, real); err != nil {
		return api.ModelLocation{}, err
	}
	prefs := m.prefs()
	if label = strings.TrimSpace(label); label != "" {
		prefs.Labels[key] = label
	} else {
		delete(prefs.Labels, key)
	}
	if err := m.savePrefs(prefs); err != nil {
		return api.ModelLocation{}, err
	}
	if err := m.WriteMountList(); err != nil {
		return api.ModelLocation{}, err
	}
	for _, row := range m.ListLocations().Locations {
		if row.Key == key {
			return row, nil
		}
	}
	return api.ModelLocation{Key: key, Path: real, Label: label}, nil
}

// RemoveLocation stops using a location. The files stay where they are;
// the refusal while an entry loads from it keeps that entry loadable.
func (m *Models) RemoveLocation(ctx context.Context, key string) error {
	if key == PrimaryLocation {
		return &Refused{"主要位置不能移除"}
	}
	if _, ok := m.location(key); !ok {
		return &Refused{"沒有這個位置"}
	}
	entries, _, err := m.entries()
	if err != nil {
		return err
	}
	var users []string
	for _, e := range entries {
		if usesLocation(e.cmd, key) {
			users = append(users, e.id)
		}
	}
	if len(users) > 0 {
		sort.Strings(users)
		return &Refused{"還有模型從這裡載入：" + strings.Join(users, "、") + "。先刪掉或改掉這些模型"}
	}
	if err := m.Store.RemoveMacro(ctx, key); err != nil {
		return err
	}
	prefs := m.prefs()
	delete(prefs.Labels, key)
	for format, k := range prefs.Defaults {
		if k == key {
			delete(prefs.Defaults, format)
		}
	}
	if err := m.savePrefs(prefs); err != nil {
		return err
	}
	return m.WriteMountList()
}

// UpdateLocation names a location -- an empty label shows the path
// instead -- and, when path is given, points it at another directory: the
// disk it is on moved, or its files were moved to a new one. The primary's
// path is CONSOLE_MODELS_DIR and not this to change. Every file an entry
// loads from the location has to be at the new path already, or those
// entries would stop loading the moment the macro changed.
func (m *Models) UpdateLocation(ctx context.Context, key, label string, path *string) error {
	loc, ok := m.location(key)
	if !ok {
		return &Refused{"沒有這個位置"}
	}
	if path != nil && strings.TrimSpace(*path) != "" && filepath.Clean(strings.TrimSpace(*path)) != loc.Path {
		if key == PrimaryLocation {
			return &Refused{"主要位置的路徑由 CONSOLE_MODELS_DIR 決定，要在服務設定裡改"}
		}
		real, err := m.checkPath(*path, key)
		if err != nil {
			return err
		}
		if real != realDir(loc.Path) {
			entries, _, err := m.entries()
			if err != nil {
				return err
			}
			var missing []string
			for _, e := range entries {
				for _, name := range weightsInCmd(e.cmd) {
					if k, rel := SplitRef(name); k == key {
						if _, err := os.Stat(filepath.Join(real, rel)); err != nil {
							missing = append(missing, e.id+"（"+rel+"）")
						}
					}
				}
			}
			if len(missing) > 0 {
				sort.Strings(missing)
				return &Refused{"新路徑底下找不到這些模型的檔案：" + strings.Join(missing, "、") + "。先把檔案搬過去再改路徑"}
			}
			if err := m.Store.AddMacro(ctx, key, real); err != nil {
				return err
			}
			if err := m.WriteMountList(); err != nil {
				return err
			}
		}
	}
	prefs := m.prefs()
	if label = strings.TrimSpace(label); label != "" {
		prefs.Labels[key] = label
	} else {
		delete(prefs.Labels, key)
	}
	return m.savePrefs(prefs)
}

// SetDefaults picks the download location per format; a format left out
// keeps the one it had.
func (m *Models) SetDefaults(defaults map[string]string) error {
	prefs := m.prefs()
	for format, key := range defaults {
		known := false
		for _, f := range Formats {
			known = known || f == format
		}
		if !known {
			return &Refused{"不認識的格式：" + format}
		}
		if _, ok := m.location(key); !ok {
			return &Refused{"沒有這個位置：" + key}
		}
		prefs.Defaults[format] = key
	}
	return m.savePrefs(prefs)
}
