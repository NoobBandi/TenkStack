package comfy

import (
	"io/fs"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/NoobBandi/TenkStack/internal/api"
)

// Sizes are re-measured this long after the last walk. The models tree
// changes when somebody downloads a checkpoint, output when a batch
// finishes: minutes, not seconds, and a walk over sixty gigabytes of
// checkpoints is not free even from the page cache.
const storageRecheck = 5 * time.Minute

type storageEntry struct {
	sizes    api.ComfyStorage
	inflight bool
}

// SlotOf is the instance's short name from its container name, which is
// what its private directories are named after.
func SlotOf(container string) string {
	return strings.TrimPrefix(container, Prefix+"-")
}

// Storage is how much of the disk one instance's directories take up,
// from the last walk, with a new one started when that is old. The first
// call after start reports nothing measured; the poll picks the numbers
// up a few seconds later.
func (m *Manager) Storage(slot string) api.ComfyStorage {
	m.mu.Lock()
	if m.storage == nil {
		m.storage = map[string]*storageEntry{}
	}
	entry := m.storage[slot]
	if entry == nil {
		entry = &storageEntry{}
		m.storage[slot] = entry
	}
	sizes := entry.sizes
	sizes.Path = m.ComfyDir
	due := !entry.inflight && (sizes.MeasuredAt == nil ||
		time.Since(time.Unix(0, int64(*sizes.MeasuredAt*1e9))) >= storageRecheck)
	if due {
		entry.inflight = true
	}
	m.mu.Unlock()
	if due {
		go m.measureStorage(slot)
	}
	return sizes
}

func (m *Manager) measureStorage(slot string) {
	root := m.ComfyDir
	shared := filepath.Join(root, "storage-models")
	user := filepath.Join(root, "storage-user")
	models := treeSize(filepath.Join(shared, "models"))
	input := treeSize(filepath.Join(user, "input"))
	output := treeSize(filepath.Join(user, "output-"+slot))
	install := treeSize(filepath.Join(root, "storage-"+slot))
	at := float64(time.Now().UnixNano()) / 1e9

	m.mu.Lock()
	defer m.mu.Unlock()
	entry := m.storage[slot]
	entry.inflight = false
	entry.sizes = api.ComfyStorage{Path: root, ModelsBytes: &models, InputBytes: &input, OutputBytes: &output,
		InstallBytes: &install, MeasuredAt: &at}
}

// treeSize is what du reports: blocks allocated, not the apparent size,
// so a sparse or reflinked checkpoint counts what it actually occupies.
// Hard links inside one tree are counted once, the way du counts them.
func treeSize(root string) int64 {
	var total int64
	seen := map[uint64]bool{}
	filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			total += info.Size()
			return nil
		}
		if st.Nlink > 1 {
			if seen[st.Ino] {
				return nil
			}
			seen[st.Ino] = true
		}
		total += st.Blocks * 512
		return nil
	})
	return total
}
