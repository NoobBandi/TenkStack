package llamaswap

import (
	"bufio"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"

	"github.com/NoobBandi/TenkStack/internal/api"
)

// The location picker: folders to choose a parent from rather than a path
// to type, and the disks on the machine, since a second disk is the usual
// reason for a second location. Folders a location could never be in --
// the system's own, snap's mounts, lost+found -- are not offered at all.

// hiddenNames are directories at any level that are nobody's model folder.
var hiddenNames = map[string]bool{"lost+found": true, "snap": true, "cdrom": true}

// Filesystems a disk of models is on; everything else in /proc/mounts is
// the kernel's, a snap's or a container's.
var diskTypes = map[string]bool{"ext2": true, "ext3": true, "ext4": true, "xfs": true, "btrfs": true, "zfs": true,
	"f2fs": true, "ntfs": true, "ntfs3": true, "fuseblk": true, "exfat": true, "vfat": true,
	"nfs": true, "nfs4": true, "cifs": true, "smb3": true}

func systemDir(p string) bool {
	for _, dir := range systemDirs {
		if p == dir || strings.HasPrefix(p, dir+"/") {
			return true
		}
	}
	return strings.HasPrefix(p, "/snap/") || p == "/snap"
}

// Disks is every mounted filesystem that could hold models, / first.
func Disks() []api.Disk {
	f, err := os.Open("/proc/mounts")
	if err != nil {
		return nil
	}
	defer f.Close()
	seen := map[string]bool{}
	var out []api.Disk
	scan := bufio.NewScanner(f)
	for scan.Scan() {
		fields := strings.Fields(scan.Text())
		if len(fields) < 3 || !diskTypes[fields[2]] {
			continue
		}
		mount := strings.ReplaceAll(fields[1], `\040`, " ")
		if seen[mount] || mount == "/boot" || strings.HasPrefix(mount, "/boot/") || (mount != "/" && systemDir(mount)) {
			continue
		}
		seen[mount] = true
		d := api.Disk{Mount: mount, Device: fields[0], FSType: fields[2], System: mount == "/"}
		var st syscall.Statfs_t
		if syscall.Statfs(mount, &st) == nil {
			d.FreeBytes = int64(st.Bavail) * int64(st.Bsize)
			d.TotalBytes = int64(st.Blocks) * int64(st.Bsize)
		}
		out = append(out, d)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].System != out[j].System {
			return out[i].System
		}
		return out[i].Mount < out[j].Mount
	})
	return out
}

// blockedAt says why p cannot be a location, or "" when it can. With
// within, only what rules out everything under p too -- p is a location, or
// inside one or inside something the console owns -- since a folder that
// merely holds one of those is still a way to somewhere that is fine.
func (m *Models) blockedAt(p string, within bool) string {
	if p == "/" {
		return "不能用根目錄"
	}
	if systemDir(p) {
		return "系統目錄"
	}
	for _, avoid := range m.Avoid {
		a := realDir(avoid)
		if p == a || strings.HasPrefix(p, a+"/") || (!within && strings.HasPrefix(a, p+"/")) {
			return "跟主控台或 ComfyUI 的資料夾重疊"
		}
	}
	prefs := m.prefs()
	for _, loc := range m.Locations() {
		root := realDir(loc.Path)
		name := prefs.Labels[loc.Key]
		if name == "" {
			name = loc.Path
			if loc.Key == PrimaryLocation {
				name = "主要位置"
			}
		}
		switch {
		case p == root:
			return "已經是模型位置（" + name + "）"
		case strings.HasPrefix(p, root+"/"):
			return "在「" + name + "」裡面"
		case !within && strings.HasPrefix(root, p+"/"):
			return "裡面已經有模型位置（" + name + "）"
		}
	}
	return ""
}

// Browse lists the folders in a directory for the picker.
func (m *Models) Browse(raw string) (api.FolderListing, error) {
	p := strings.TrimSpace(raw)
	if p == "" {
		p = "/"
	}
	if !filepath.IsAbs(p) {
		return api.FolderListing{}, &Refused{"要是完整路徑"}
	}
	p = realDir(filepath.Clean(p))
	st, err := os.Stat(p)
	if err != nil || !st.IsDir() {
		return api.FolderListing{}, &Refused{"找不到這個資料夾"}
	}
	entries, err := os.ReadDir(p)
	if err != nil {
		return api.FolderListing{}, &Refused{"主控台讀不到這個資料夾"}
	}
	out := api.FolderListing{Path: p, Parent: filepath.Dir(p), Folders: []api.FolderEntry{},
		Writable: syscall.Access(p, 0x2|0x1) == nil, Blocked: m.blockedAt(p, false), Disks: Disks()}
	if p == "/" {
		out.Parent = ""
	}
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") || hiddenNames[name] || strings.HasSuffix(name, ".usr-is-merged") {
			continue
		}
		child := filepath.Join(p, name)
		// A link counts as what it points at: bin is /usr/bin.
		real := realDir(child)
		info, err := os.Stat(real)
		if err != nil || !info.IsDir() || systemDir(real) {
			continue
		}
		if syscall.Access(real, 0x4|0x1) != nil {
			continue
		}
		out.Folders = append(out.Folders, api.FolderEntry{Name: name, Path: real, Blocked: m.blockedAt(real, true)})
		if len(out.Folders) >= 500 {
			break
		}
	}
	sort.Slice(out.Folders, func(i, j int) bool {
		return strings.ToLower(out.Folders[i].Name) < strings.ToLower(out.Folders[j].Name)
	})
	return out, nil
}
