package llamaswap

import (
	"context"
	"fmt"
	"io/fs"
	"log"
	"math"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
	"github.com/NoobBandi/TenkStack/server-go/internal/providers"
)

// Sampling fields the form owns, in the order they are written.
var Sampling = []string{"temperature", "top_k", "top_p", "min_p", "repeat_penalty", "presence_penalty"}

func samplingFlag(field string) string { return "--" + strings.ReplaceAll(field, "_", "-") }

// Sampling flags a model entry may carry, mapped to the names the chat
// panel uses. Both spellings are matched since llama.cpp accepts either.
var samplingFlags = []struct{ flag, name string }{
	{"temp", "temperature"}, {"temperature", "temperature"}, {"top-p", "top_p"}, {"top-k", "top_k"},
	{"min-p", "min_p"}, {"presence-penalty", "presence_penalty"},
	{"frequency-penalty", "frequency_penalty"}, {"repeat-penalty", "repeat_penalty"},
}

var samplingInts = map[string]bool{"top_k": true}

var samplingPatterns = func() map[string]*regexp.Regexp {
	out := map[string]*regexp.Regexp{}
	for _, f := range samplingFlags {
		out[f.flag] = regexp.MustCompile(`--` + strings.ReplaceAll(f.flag, "-", "[-_]") + `\s+(-?[\d.]+)`)
	}
	return out
}()

func samplingIn(cmd string, only map[string]bool) map[string]any {
	found := map[string]any{}
	for _, f := range samplingFlags {
		if only != nil && !only[f.name] {
			continue
		}
		m := samplingPatterns[f.flag].FindStringSubmatch(cmd)
		if m == nil {
			continue
		}
		v, err := strconv.ParseFloat(m[1], 64)
		if err != nil {
			continue
		}
		if samplingInts[f.name] {
			found[f.name] = int(v)
		} else {
			found[f.name] = v
		}
	}
	return found
}

var formSampling = func() map[string]bool {
	m := map[string]bool{}
	for _, s := range Sampling {
		m[s] = true
	}
	return m
}()

// BuildCmd assembles a llama-server command line. --n-gpu-layers 0 means
// leave the flag out and let llama.cpp decide.
func BuildCmd(modelFile string, ctxSize, nGpuLayers int, extra string, mmproj *string, wrapper string, sampling map[string]float64) string {
	if wrapper == "" {
		wrapper = FallbackWrapper
	}
	lines := []string{wrapper, "--model " + cmdPath(modelFile), "--host 127.0.0.1 --port ${PORT}"}
	if nGpuLayers != 0 {
		lines = append(lines, fmt.Sprintf("--n-gpu-layers %d", nGpuLayers))
	}
	lines = append(lines, fmt.Sprintf("--ctx-size %d", ctxSize), "--jinja")
	if mmproj != nil && *mmproj != "" {
		lines = append(lines, "--mmproj "+cmdPath(*mmproj))
	}
	for _, field := range Sampling {
		if v, ok := sampling[field]; ok {
			lines = append(lines, samplingFlag(field)+" "+strconv.FormatFloat(v, 'g', 6, 64))
		}
	}
	for _, line := range strings.Split(strings.TrimSpace(extra), "\n") {
		if t := strings.TrimSpace(line); t != "" {
			lines = append(lines, t)
		}
	}
	return strings.Join(lines, "\n") + "\n"
}

var groupPolicies = map[string][2]bool{ // swap, exclusive
	"small": {false, false},
	"large": {true, true},
}

// syncGroupMembership puts the model in exactly one group, creating it if
// needed. Membership is rebuilt so moving a model cannot leave it in two.
func syncGroupMembership(c *Config, modelID string, group *string) {
	if groups := c.Root().Map("groups"); groups != nil {
		for _, name := range groups.Keys() {
			spec := groups.Map(name)
			if spec == nil {
				continue
			}
			members := Strings(spec.Get("members"))
			keep := make([]string, 0, len(members))
			found := false
			for _, m := range members {
				if m == modelID {
					found = true
				} else {
					keep = append(keep, m)
				}
			}
			if found {
				// Emptied, never removed: deleting the last group strands the
				// comments above it.
				spec.Set("members", Seq(keep...))
			}
		}
	}
	if group == nil {
		return
	}
	groups := c.Root().EnsureMap("groups")
	spec := groups.Map(*group)
	if spec == nil {
		// Unknown names fail safe as exclusive: assuming a model shares the
		// card costs an out-of-memory failure, the other way an unload.
		policy, ok := groupPolicies[*group]
		if !ok {
			policy = [2]bool{true, true}
		}
		spec = groups.EnsureMap(*group)
		spec.Set("swap", Bool(policy[0]))
		spec.Set("exclusive", Bool(policy[1]))
		spec.Set("members", Seq())
	}
	members := Strings(spec.Get("members"))
	for _, m := range members {
		if m == modelID {
			return
		}
	}
	spec.Set("members", Seq(append(members, modelID)...))
}

// Upsert merges into an existing entry rather than replacing it: keys the
// form does not know (aliases, filters, cmdStop) are not its to delete.
// An edit that names no launcher keeps the one already there; only the
// environment variables the caller manages are cleared.
func (s *Store) Upsert(ctx context.Context, spec api.ModelSpec, env map[string]string, managedEnv map[string]bool, wrapper string) error {
	return s.Edit(ctx, func(c *Config) error {
		models := c.Root().EnsureMap("models")
		entry := models.Map(spec.ID)
		if entry == nil {
			entry = models.EnsureMap(spec.ID)
		}
		name := spec.Name
		if name == "" {
			name = spec.ID
		}
		entry.Set("name", Str(name))
		entry.Set("description", Str(spec.Description))
		if wrapper == "" {
			wrapper = WrapperIn(Scalar(entry.Get("cmd")))
		}
		if wrapper == "" {
			wrapper = s.DefaultWrapper()
		}
		previous := Scalar(entry.Get("cmd"))
		p, _, managed := ProviderOf(wrapper)
		// The container's name is the launcher's business, so its variable
		// is always this form's to rewrite, whichever launcher it was.
		owned := map[string]bool{}
		for k, v := range managedEnv {
			owned[k] = v
		}
		for _, other := range providers.All() {
			if other.EnvPrefix != "" {
				owned[other.EnvPrefix+"_NAME"] = true
			}
		}
		env = copyEnv(env)
		if managed {
			name := containerName(strings.Trim(wrapper, "${}"), spec.ID)
			env[p.EnvPrefix+"_NAME"] = name
			entry.Set("cmdStop", Str("docker stop "+name))
		} else if strings.HasPrefix(Scalar(entry.Get("cmdStop")), "docker stop ") {
			// Moved to a native launcher: the stop that reached a container
			// would now stop nothing, and llama-swap would wait on it.
			entry.Delete("cmdStop")
		}
		switch p.Form {
		case providers.FormServer:
			// The card count comes from the selector being written, else
			// from the one already there.
			tp := tensorParallel(env)
			if tp == 0 && managedEnv == nil {
				tp = tensorParallel(EnvMap(entry.Get("env")))
			}
			if tp == 0 {
				if m := serverPatterns(p)["tensor_parallel"].FindStringSubmatch(previous); m != nil {
					tp, _ = strconv.Atoi(m[1])
				}
			}
			entry.Set("cmd", Literal(BuildServerCmd(p, spec.ID, spec.ModelFile, spec.CtxSize, tp,
				spec.GpuMemoryUtilization, spec.Quantization, spec.Extra, wrapper)))
		default:
			entry.Set("cmd", Literal(BuildCmd(spec.ModelFile, spec.CtxSize, spec.NGpuLayers, spec.Extra, spec.Mmproj, wrapper, spec.Sampling)))
		}
		entry.Set("ttl", Int(spec.TTL))

		var merged []string
		for _, item := range EnvPairs(entry.Get("env")) {
			name, _, _ := strings.Cut(item, "=")
			if !owned[name] {
				merged = append(merged, item)
			}
		}
		for _, name := range sortedKeys(env) {
			merged = append(merged, name+"="+env[name])
		}
		if len(merged) > 0 {
			entry.Set("env", Seq(merged...))
		} else {
			entry.Delete("env")
		}
		syncGroupMembership(c, spec.ID, spec.Group)
		return nil
	})
}

func copyEnv(m map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range m {
		out[k] = v
	}
	return out
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// Every flag llama-server takes that names a GGUF, long and short. The
// draft model of a speculative entry counts as referenced too.
var fileFlags = regexp.MustCompile(`(?:--(model|mmproj|spec-draft-model|model-draft|lora|lora-scaled|control-vector|control-vector-scaled)|-(m|mm|md))\s+(\S+?\.gguf)`)

var roles = map[string]string{
	"model": "weights", "m": "weights",
	"mmproj": "projector", "mm": "projector",
	"spec-draft-model": "draft", "model-draft": "draft", "md": "draft",
	"lora": "lora", "lora-scaled": "lora",
	"control-vector": "control", "control-vector-scaled": "control",
}

// Which role wins when a file is used two ways: being somebody's weights
// is the strongest claim.
var roleOrder = map[string]int{"weights": 0, "draft": 1, "projector": 2, "lora": 3, "control": 4}

// ${models-dir}/…, llama-swap's macro for the models directory.
var macroPrefix = regexp.MustCompile(`^\$\{[^}]+\}/`)

// relativeName is how the console names a file a cmd points at: a model
// location's macro becomes that location's name for it, any other macro is
// dropped, and an absolute path is known by its base name alone.
func relativeName(raw string) string {
	if m := refPattern.FindStringSubmatch(raw); m != nil {
		return Ref(m[1], m[2])
	}
	rel := macroPrefix.ReplaceAllString(raw, "")
	if strings.HasPrefix(rel, "/") {
		return path.Base(rel)
	}
	return rel
}

// specName is relativeName for the editor, which keeps an absolute path
// as written: it is somebody's own and goes back unchanged.
func specName(raw string) string {
	if m := refPattern.FindStringSubmatch(raw); m != nil {
		return Ref(m[1], m[2])
	}
	return macroPrefix.ReplaceAllString(raw, "")
}

// filesInCmd is every GGUF a model entry references, relative to the
// models directory, in sorted order.
// A model too large for one file is published as …-00001-of-00003.gguf and
// its siblings, and llama-server is given only the first; it finds the rest
// by name. The shards are the model as much as the first is, so everything
// that asks which files an entry uses gets all of them.
var splitShard = regexp.MustCompile(`^(.+)-00001-of-(\d{5})\.gguf$`)

// shardsOf is every shard of a split GGUF named by its first, or the name
// alone when it is not split.
func shardsOf(name string) []string {
	m := splitShard.FindStringSubmatch(name)
	if m == nil {
		return []string{name}
	}
	n, _ := strconv.Atoi(m[2])
	out := make([]string, 0, n)
	for i := 1; i <= n; i++ {
		out = append(out, fmt.Sprintf("%s-%05d-of-%s.gguf", m[1], i, m[2]))
	}
	return out
}

func filesInCmd(cmd string) []string {
	seen := map[string]bool{}
	for _, m := range fileFlags.FindAllStringSubmatch(cmd, -1) {
		for _, shard := range shardsOf(relativeName(m[3])) {
			seen[shard] = true
		}
	}
	out := make([]string, 0, len(seen))
	for name := range seen {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

func rolesInCmd(cmd string) map[string]string {
	out := map[string]string{}
	for _, m := range fileFlags.FindAllStringSubmatch(cmd, -1) {
		flag := m[1]
		if flag == "" {
			flag = m[2]
		}
		role, ok := roles[flag]
		if !ok {
			role = "weights"
		}
		for _, name := range shardsOf(relativeName(m[3])) {
			if prev, has := out[name]; !has || roleOrder[role] < roleOrder[prev] {
				out[name] = role
			}
		}
	}
	return out
}

// Models is the weights layout: where the files live and what the config
// says about them.
type Models struct {
	Store *Store
	// Dir is the primary model location, CONSOLE_MODELS_DIR.
	Dir string
	// Prefs is the file of location labels and download defaults.
	Prefs string
	// Avoid is directories a location may not overlap: the ComfyUI storage
	// and the console's own state.
	Avoid []string
}

// resolve is where a name is on disk, or "" if its location is unknown or
// the path escapes it.
func (m *Models) resolve(name string) string {
	abs, _, ok := m.Place(name)
	if !ok {
		return ""
	}
	return abs
}

func fileSize(p string) (int64, bool) {
	st, err := os.Stat(p)
	if err != nil || !st.Mode().IsRegular() {
		return 0, false
	}
	return st.Size(), true
}

// weightsInCmd is every set of weights an entry names: its GGUF files
// and, for a vLLM entry, the directory of safetensors.
func weightsInCmd(cmd string) []string {
	return append(filesInCmd(cmd), dirsInCmd(cmd)...)
}

// weightSize is a file's size, or a directory's as the sum of what is in
// it, which is what deleting or fitting it costs.
func (m *Models) weightSize(name string) (int64, bool) {
	p := m.resolve(name)
	if p == "" {
		return 0, false
	}
	st, err := os.Stat(p)
	if err != nil {
		return 0, false
	}
	if !st.IsDir() {
		return st.Size(), st.Mode().IsRegular()
	}
	return dirSize(p), true
}

func dirSize(dir string) int64 {
	var total int64
	filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total
}

// removeWeights deletes one file, or one directory of weights with
// everything in it. Never the models directory itself.
func (m *Models) removeWeights(p string) error {
	st, err := os.Stat(p)
	if err != nil {
		return err
	}
	if !st.IsDir() {
		return os.Remove(p)
	}
	if p == m.rootOf(p) {
		return fmt.Errorf("不刪模型目錄本身")
	}
	// Only a directory that is a model: a publisher's directory holding
	// several would take every one of them with it.
	if !isWeightDir(p) {
		return fmt.Errorf("這個資料夾不是一個模型")
	}
	return os.RemoveAll(p)
}

// isWeightDir says whether a directory is one model as Hugging Face lays it
// out: a config.json with at least one safetensors shard beside it.
func isWeightDir(p string) bool {
	if _, err := os.Stat(filepath.Join(p, "config.json")); err != nil {
		return false
	}
	shards, _ := filepath.Glob(filepath.Join(p, "*.safetensors"))
	return len(shards) > 0
}

type modelEntry struct {
	id   string
	spec *Mapping
	cmd  string
}

func (m *Models) entries() ([]modelEntry, *Config, error) {
	c, err := m.Store.Load()
	if err != nil {
		return nil, nil, err
	}
	var out []modelEntry
	if models := c.Root().Map("models"); models != nil {
		for _, id := range models.Keys() {
			spec := models.Map(id)
			cmd := ""
			if spec != nil {
				cmd = Scalar(spec.Get("cmd"))
			}
			out = append(out, modelEntry{id, spec, cmd})
		}
	}
	return out, c, nil
}

func (m *Models) ContextSizes() map[string]int {
	out := map[string]int{}
	entries, _, err := m.entries()
	if err != nil {
		log.Printf("could not read the config while reading context sizes: %v", err)
		return out
	}
	for _, e := range entries {
		if mm := ctxFlag.FindStringSubmatch(e.cmd); mm != nil {
			out[e.id], _ = strconv.Atoi(mm[1])
		} else if mm := anyContext.FindStringSubmatch(e.cmd); mm != nil {
			out[e.id], _ = strconv.Atoi(mm[1])
		}
	}
	return out
}

var (
	ctxFlag     = regexp.MustCompile(`--ctx-size\s+(\d+)`)
	mmprojFlag  = regexp.MustCompile(`--mmproj\s+\S+`)
	mmprojFiles = regexp.MustCompile(`--mmproj\s+(\S+\.gguf)`)
)

// DeclaredVision says whether each command line asks for an mmproj: a
// declaration, which a running model's /props overrides.
func (m *Models) DeclaredVision() map[string]bool {
	out := map[string]bool{}
	entries, _, err := m.entries()
	if err != nil {
		log.Printf("could not read the config while checking for mmproj: %v", err)
		return out
	}
	for _, e := range entries {
		out[e.id] = mmprojFlag.MatchString(e.cmd)
		// A vLLM entry names a directory; whether it sees images is in
		// the architecture its config.json declares.
		for _, dir := range dirsInCmd(e.cmd) {
			if p := m.resolve(dir); p != "" && seesImages(architectureOf(p)) {
				out[e.id] = true
			}
		}
	}
	return out
}

// ProviderKeys is which provider each entry starts through.
func (m *Models) ProviderKeys() map[string]string {
	out := map[string]string{}
	entries, _, err := m.entries()
	if err != nil {
		return out
	}
	for _, e := range entries {
		p, _, _ := ProviderOf(e.cmd)
		out[e.id] = p.Key
	}
	return out
}

// ChatParams is, per entry, the chat panel's controls its engine takes,
// each under the engine's own name.
func (m *Models) ChatParams() map[string]map[string]string {
	out := map[string]map[string]string{}
	entries, _, err := m.entries()
	if err != nil {
		return out
	}
	for _, e := range entries {
		p, _, _ := ProviderOf(e.cmd)
		out[e.id] = p.ChatParams(e.cmd)
	}
	return out
}

// Refused is, per entry, the request fields its engine would refuse given
// how the entry is started. Entries that take everything are absent.
func (m *Models) Refused() map[string][]string {
	out := map[string][]string{}
	entries, _, err := m.entries()
	if err != nil {
		return out
	}
	for _, e := range entries {
		p, _, _ := ProviderOf(e.cmd)
		if fields := p.Refused(e.cmd); len(fields) > 0 {
			out[e.id] = fields
		}
	}
	return out
}

// SamplingDefaults is each model's sampling flags, so the chat panel
// starts from what the model was configured with.
func (m *Models) SamplingDefaults() map[string]map[string]any {
	out := map[string]map[string]any{}
	entries, _, err := m.entries()
	if err != nil {
		log.Printf("could not read the config while reading sampling defaults: %v", err)
		return out
	}
	for _, e := range entries {
		if found := samplingIn(e.cmd, nil); len(found) > 0 {
			out[e.id] = found
		}
	}
	return out
}

// Weights is every model's GGUF files with sizes and who else points at
// them, in one pass because sharing is a property of the whole set.
func (m *Models) Weights() map[string][]api.Weight {
	out := map[string][]api.Weight{}
	entries, _, err := m.entries()
	if err != nil {
		log.Printf("could not read the config while listing weights: %v", err)
		return out
	}
	references := map[string][]string{}
	for _, e := range entries {
		for _, name := range weightsInCmd(e.cmd) {
			references[name] = append(references[name], e.id)
		}
	}
	for _, e := range entries {
		projectors := map[string]bool{}
		for _, mm := range mmprojFiles.FindAllStringSubmatch(e.cmd, -1) {
			projectors[relativeName(mm[1])] = true
		}
		list := []api.Weight{}
		dirs := map[string]bool{}
		for _, d := range dirsInCmd(e.cmd) {
			dirs[d] = true
		}
		// A split GGUF is one row, named by its first shard: the others are
		// folded into it below rather than listed as files of their own.
		firstOf := map[string]string{}
		for _, name := range filesInCmd(e.cmd) {
			if mm := splitShard.FindStringSubmatch(name); mm != nil {
				for _, shard := range shardsOf(name) {
					firstOf[shard] = name
				}
			}
		}
		for _, name := range weightsInCmd(e.cmd) {
			if first, ok := firstOf[name]; ok && first != name {
				continue
			}
			size, exists := m.weightSize(name)
			parts := 0
			if _, ok := firstOf[name]; ok {
				parts = len(shardsOf(name))
				for _, shard := range shardsOf(name)[1:] {
					more, there := m.weightSize(shard)
					size += more
					exists = exists && there
				}
			}
			shared := []string{}
			for _, other := range references[name] {
				if other != e.id {
					shared = append(shared, other)
				}
			}
			sort.Strings(shared)
			role := "model"
			if projectors[name] {
				role = "mmproj"
			}
			key, rel := SplitRef(name)
			repo := repoOf(rel)
			if dirs[name] {
				// A safetensors model is its folder: <owner>/<name> is the repo.
				repo = rel
			}
			list = append(list, api.Weight{
				Filename: name, Basename: path.Base(rel), Repo: repo, Role: role,
				Exists: exists, SizeBytes: size, SharedWith: shared, Parts: parts, Location: key,
			})
		}
		sort.SliceStable(list, func(i, j int) bool {
			a, b := list[i], list[j]
			if (a.Role != "model") != (b.Role != "model") {
				return a.Role == "model"
			}
			return a.Basename < b.Basename
		})
		out[e.id] = list
	}
	return out
}

func repoOf(name string) string {
	if strings.Contains(name, "/") {
		return path.Dir(name)
	}
	return ""
}

// FilesForModel is what deleting a model would remove, with sharing status
// so nothing is pulled out from under another entry.
func (m *Models) FilesForModel(modelID string) ([]api.ModelFile, bool) {
	entries, _, err := m.entries()
	if err != nil {
		return nil, false
	}
	var target *modelEntry
	for i := range entries {
		if entries[i].id == modelID {
			target = &entries[i]
		}
	}
	if target == nil {
		return nil, false
	}
	out := []api.ModelFile{}
	for _, name := range weightsInCmd(target.cmd) {
		others := []string{}
		for _, e := range entries {
			if e.id == modelID {
				continue
			}
			for _, n := range weightsInCmd(e.cmd) {
				if n == name {
					others = append(others, e.id)
				}
			}
		}
		sort.Strings(others)
		size, exists := m.weightSize(name)
		out = append(out, api.ModelFile{Filename: name, Exists: exists, SizeBytes: size, SharedWith: others})
	}
	return out, true
}

// pruneEmpty removes the repo directories a deleted file leaves behind,
// never the models directory itself.
func (m *Models) pruneEmpty(dir string) {
	base := m.rootOf(dir)
	if base == "" {
		return
	}
	cur := dir
	for cur != base && strings.HasPrefix(cur, base+string(filepath.Separator)) {
		if err := os.Remove(cur); err != nil {
			return
		}
		cur = filepath.Dir(cur)
	}
}

// Delete removes a model entry and, when asked, its files. Files another
// entry still references are always kept.
func (m *Models) Delete(ctx context.Context, modelID string, deleteFiles bool) (*api.ModelDeleted, error) {
	var candidates []api.ModelFile
	found := false
	err := m.Store.Edit(ctx, func(c *Config) error {
		models := c.Root().Map("models")
		if models == nil || !models.Has(modelID) {
			return nil
		}
		found = true
		if deleteFiles {
			candidates, _ = m.FilesForModel(modelID)
		}
		models.Delete(modelID)
		syncGroupMembership(c, modelID, nil)
		return nil
	})
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}
	result := &api.ModelDeleted{OK: true, Deleted: []api.DeletedFile{}, Kept: []api.KeptFile{}}
	for _, f := range candidates {
		if len(f.SharedWith) > 0 {
			result.Kept = append(result.Kept, api.KeptFile{Filename: f.Filename, Reason: "仍被 " + strings.Join(f.SharedWith, ", ") + " 使用"})
			continue
		}
		p := m.resolve(f.Filename)
		if p == "" {
			result.Kept = append(result.Kept, api.KeptFile{Filename: f.Filename, Reason: "路徑不在模型目錄底下"})
			continue
		}
		if err := m.removeWeights(p); err != nil {
			reason := err.Error()
			if os.IsNotExist(err) {
				reason = "檔案不存在"
			}
			result.Kept = append(result.Kept, api.KeptFile{Filename: f.Filename, Reason: reason})
			continue
		}
		m.pruneEmpty(filepath.Dir(p))
		result.Deleted = append(result.Deleted, api.DeletedFile{Filename: f.Filename, SizeBytes: f.SizeBytes})
		log.Printf("deleted %s (%.1f GiB)", filepath.Base(p), float64(f.SizeBytes)/(1<<30))
	}
	log.Printf("deleted model %s (files: %d removed, %d kept)", modelID, len(result.Deleted), len(result.Kept))
	return result, nil
}

// Refused is a file deletion that must not happen, with the reason.
type Refused struct{ Reason string }

func (r *Refused) Error() string { return r.Reason }

// DeleteFile removes one set of weights -- a GGUF, or a directory of
// safetensors -- refusing if a model still points at it.
func (m *Models) DeleteFile(filename string) (*api.FileDeleted, error) {
	p := m.resolve(filename)
	if p == "" {
		return nil, &Refused{"路徑不在模型目錄底下"}
	}
	size, exists := m.weightSize(filename)
	if !exists {
		return nil, &Refused{"檔案不存在"}
	}
	entries, _, err := m.entries()
	if err != nil {
		return nil, err
	}
	var users []string
	for _, e := range entries {
		for _, n := range weightsInCmd(e.cmd) {
			if n == filename {
				users = append(users, e.id)
			}
		}
	}
	if len(users) > 0 {
		sort.Strings(users)
		return nil, &Refused{"仍被 " + strings.Join(users, ", ") + " 使用"}
	}
	if err := m.removeWeights(p); err != nil {
		return nil, &Refused{err.Error()}
	}
	m.pruneEmpty(filepath.Dir(p))
	log.Printf("deleted orphan file %s (%.1f GiB)", filename, float64(size)/(1<<30))
	return &api.FileDeleted{OK: true, Filename: filename, SizeBytes: size}, nil
}

func gib(size int64) float64 { return math.RoundToEven(float64(size)/(1<<30)*100) / 100 }

// ListGGUF is every GGUF on disk, annotated with the models that reference
// it; an empty used_by is what identifies an orphan.
func (m *Models) ListGGUF() []api.GGUFFile {
	out := []api.GGUFFile{}
	entries, _, err := m.entries()
	if err != nil {
		log.Printf("could not read the config while listing files: %v", err)
	}
	references := map[string][]string{}
	fileRoles := map[string]string{}
	for _, e := range entries {
		for name, role := range rolesInCmd(e.cmd) {
			references[name] = append(references[name], e.id)
			if prev, has := fileRoles[name]; !has || roleOrder[role] < roleOrder[prev] {
				fileRoles[name] = role
			}
		}
	}
	for _, loc := range m.Locations() {
		for _, p := range glob(loc.Path, "*.gguf") {
			out = append(out, ggufRow(loc, p, fileRoles, references)...)
		}
	}
	return out
}

// ggufRow is one GGUF in one location, or nil when it cannot be read.
func ggufRow(loc Location, p string, fileRoles map[string]string, references map[string][]string) []api.GGUFFile {
	st, err := os.Stat(p)
	if err != nil {
		return nil
	}
	rel, _ := filepath.Rel(loc.Path, p)
	rel = filepath.ToSlash(rel)
	ref := Ref(loc.Key, rel)
	lower := strings.ToLower(filepath.Base(p))
	role, ok := fileRoles[ref]
	if !ok {
		role = "weights"
		if strings.HasPrefix(lower, "mmproj") {
			role = "projector"
		}
	}
	used := append([]string{}, references[ref]...)
	sort.Strings(used)
	return []api.GGUFFile{{
		Filename: ref, Location: loc.Key, Repo: repoOf(rel), SizeBytes: st.Size(), SizeGiB: gib(st.Size()),
		// sec + nsec*1e-9, the arithmetic Python's st_mtime uses, so the
		// two agree to the last digit.
		Modified: float64(st.ModTime().Unix()) + float64(st.ModTime().Nanosecond())*1e-9,
		IsMmproj: strings.HasPrefix(lower, "mmproj"), Role: role, UsedBy: used,
	}}
}

// ListWeights is ListGGUF and every directory of safetensors beside them,
// one entry per directory: a config.json with at least one shard next to
// it is how Hugging Face lays a model out.
func (m *Models) ListWeights() []api.GGUFFile {
	out := m.ListGGUF()
	for i := range out {
		out[i].Format = "gguf"
	}
	entries, _, _ := m.entries()
	references := map[string][]string{}
	for _, e := range entries {
		for _, name := range dirsInCmd(e.cmd) {
			references[name] = append(references[name], e.id)
		}
	}
	for _, loc := range m.Locations() {
		out = append(out, weightDirs(loc, references)...)
	}
	return out
}

// weightDirs is every directory of safetensors in one location.
func weightDirs(loc Location, references map[string][]string) []api.GGUFFile {
	out := []api.GGUFFile{}
	if st, err := os.Stat(loc.Path); err != nil || !st.IsDir() {
		return out
	}
	filepath.WalkDir(loc.Path, func(p string, d fs.DirEntry, err error) error {
		if err != nil || !d.IsDir() {
			return nil
		}
		if !isWeightDir(p) {
			return nil
		}
		config, _ := os.Stat(filepath.Join(p, "config.json"))
		rel, _ := filepath.Rel(loc.Path, p)
		rel = filepath.ToSlash(rel)
		ref := Ref(loc.Key, rel)
		used := append([]string{}, references[ref]...)
		sort.Strings(used)
		size := dirSize(p)
		precision, quantized := precisionOf(p)
		// The directory is the repo: <owner>/<name> as Hugging Face has it,
		// and the one entry under it is the whole model.
		out = append(out, api.GGUFFile{
			Filename: ref, Location: loc.Key, Format: "safetensors", Repo: rel, SizeBytes: size, SizeGiB: gib(size),
			Precision: precision, Quantized: quantized, Architecture: architectureOf(p),
			Modified: float64(config.ModTime().Unix()) + float64(config.ModTime().Nanosecond())*1e-9,
			Role:     "weights", UsedBy: used,
		})
		// A model directory holds nothing that is another model.
		return fs.SkipDir
	})
	return out
}

// glob walks one location for a suffix, sorted by path.
func glob(dir, pattern string) []string {
	var found []string
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return found
	}
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if ok, _ := filepath.Match(pattern, d.Name()); ok {
			found = append(found, p)
		}
		return nil
	})
	sort.Strings(found)
	return found
}

// ListPartials is the interrupted downloads: resumable, but real disk.
func (m *Models) ListPartials() []api.Partial {
	out := []api.Partial{}
	for _, loc := range m.Locations() {
		for _, p := range glob(loc.Path, "*.part") {
			st, err := os.Stat(p)
			if err != nil {
				continue
			}
			rel, _ := filepath.Rel(loc.Path, p)
			out = append(out, api.Partial{Filename: Ref(loc.Key, filepath.ToSlash(rel)), Location: loc.Key,
				SizeBytes: st.Size(), SizeGiB: gib(st.Size())})
		}
	}
	return out
}

func (m *Models) DeletePartial(filename string) (*api.FileDeleted, error) {
	if !strings.HasSuffix(filename, ".part") {
		return nil, &Refused{"只能刪除 .part 檔"}
	}
	p := m.resolve(filename)
	if p == "" {
		return nil, &Refused{"路徑不在模型目錄底下"}
	}
	size, exists := fileSize(p)
	if !exists {
		return nil, &Refused{"檔案不存在"}
	}
	if err := os.Remove(p); err != nil {
		return nil, &Refused{err.Error()}
	}
	// The resume ledger goes with it, or the next download believes it.
	os.Remove(p + ".state")
	m.pruneEmpty(filepath.Dir(p))
	return &api.FileDeleted{OK: true, Filename: filename, SizeBytes: size}, nil
}

var argPatterns = map[string]*regexp.Regexp{
	"model_file":   regexp.MustCompile(`--model\s+(\S+\.gguf)`),
	"mmproj":       regexp.MustCompile(`--mmproj\s+(\S+\.gguf)`),
	"ctx_size":     regexp.MustCompile(`--ctx-size\s+(\d+)`),
	"n_gpu_layers": regexp.MustCompile(`--n-gpu-layers\s+(\d+)`),
}

// Flags the editor owns, matched by prefix as before. Anything else in cmd
// is the user's own and comes back as free text.
var managed = func() []string {
	out := []string{"--model", "--mmproj", "--ctx-size", "--n-gpu-layers", "--host", "--port", "--jinja"}
	for _, field := range Sampling {
		out = append(out, "--"+field)
		if h := "--" + strings.ReplaceAll(field, "_", "-"); h != "--"+field {
			out = append(out, h)
		}
	}
	return append(out, "--temp")
}()

// ReadSpec parses a model's cmd back into the editor's fields; unmanaged
// flags survive a round trip in extra.
func (m *Models) ReadSpec(modelID string) *api.ModelSpecOut {
	entries, c, err := m.entries()
	if err != nil {
		log.Printf("could not read the config while loading a model spec: %v", err)
		return nil
	}
	var e *modelEntry
	for i := range entries {
		if entries[i].id == modelID {
			e = &entries[i]
		}
	}
	if e == nil || e.spec == nil {
		return nil
	}
	p, _, _ := ProviderOf(e.cmd)
	patterns, owns := argPatterns, managed
	if p.Form == providers.FormServer {
		patterns, owns = serverPatterns(p), p.Managed
	}
	values := map[string]string{}
	for field, pat := range patterns {
		if mm := pat.FindStringSubmatch(e.cmd); mm != nil {
			values[field] = mm[1]
		}
	}
	for _, field := range []string{"model_file", "mmproj", "model_dir"} {
		if v, ok := values[field]; ok {
			values[field] = specName(v)
		}
	}
	var extra []string
	for _, line := range strings.Split(e.cmd, "\n") {
		t := strings.TrimSpace(line)
		if t == "" || strings.HasPrefix(t, "${") || strings.HasPrefix(t, "#") {
			continue
		}
		owned := false
		for _, flag := range owns {
			if strings.HasPrefix(t, flag) {
				owned = true
				break
			}
		}
		if !owned {
			extra = append(extra, t)
		}
	}
	var group *string
	if groups := c.Root().Map("groups"); groups != nil {
		for _, name := range groups.Keys() {
			for _, member := range Strings(groups.Map(name).Get("members")) {
				if member == modelID && group == nil {
					n := name
					group = &n
				}
			}
		}
	}
	out := &api.ModelSpecOut{
		ID:          modelID,
		Env:         EnvMap(e.spec.Get("env")),
		Wrapper:     WrapperIn(e.cmd),
		Runtime:     strings.Trim(WrapperIn(e.cmd), "${}"),
		Provider:    p.Key,
		Format:      "gguf",
		Name:        Scalar(e.spec.Get("name")),
		Description: Scalar(e.spec.Get("description")),
		ModelFile:   values["model_file"],
		CtxSize:     16384,
		Group:       group,
		Sampling:    samplingIn(e.cmd, formSampling),
		Extra:       strings.Join(extra, "\n"),
	}
	if out.Name == "" {
		out.Name = modelID
	}
	if p.Form == providers.FormServer {
		out.Format = "safetensors"
		out.ModelFile = values["model_dir"]
		out.Sampling = map[string]any{}
		out.Quantization = values["quantization"]
		out.GpuMemoryUtilization, _ = strconv.ParseFloat(values["gpu_memory_utilization"], 64)
		if v, ok := values["max_model_len"]; ok {
			out.CtxSize, _ = strconv.Atoi(v)
		}
	}
	if v, ok := values["mmproj"]; ok {
		out.Mmproj = &v
	}
	if v, ok := values["ctx_size"]; ok {
		out.CtxSize, _ = strconv.Atoi(v)
	}
	if v, ok := values["n_gpu_layers"]; ok {
		out.NGpuLayers, _ = strconv.Atoi(v)
	}
	if ttl := e.spec.Get("ttl"); ttl != nil && ttl.Kind == yaml.ScalarNode {
		out.TTL, _ = strconv.Atoi(ttl.Value)
	}
	return out
}
