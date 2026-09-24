package comfy

import (
	"bytes"
	"embed"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// fetchNode is the model-fetch extension: a panel beside the frontend's
// missing-models dialog that has this server, not the browser, download
// what a workflow needs. all: because a Python package's __init__.py
// starts with an underscore, which embed otherwise skips.
//
//go:embed all:fetchnode
var fetchNode embed.FS

// fetchNodeDir is where the extension lives in the shared user storage, and
// the name it is linked under in custom_nodes.
const fetchNodeDir = "tenkstack-nodes/tenkstack_fetch"

// Two files under the shared user storage make a fresh instance usable from
// ComfyUI-Manager's own interface. Both are written for every instance on
// the machine, because storage-user is one mount they all share.
//
// The first is the image's pre-start hook. Since v3.4x the Manager lets
// "Install via Git URL" through only when a config flag is set AND ComfyUI
// listens on a loopback address. The second is its way of saying "only
// someone at this machine's console", and it is the wrong test in a
// container: ComfyUI has to bind 0.0.0.0 for anything outside to reach it,
// and the loopback it could bind is the container's own. What stands
// between the internet and that UI is the console's login in front of it,
// which the Manager cannot see. The hook drops the loopback term on every
// start, since the Manager updates itself and would put it back.
//
// The second is the Manager's config, with that flag on.
//
// The hook is rewritten while it still carries the managed mark, so a fix
// here reaches every installation; a hook somebody has taken over is left
// alone. The config is only added to, never changed: a flag somebody set
// off stays off.

const managedMark = "# managed by TenkStack"

const preStart = `#!/usr/bin/env bash
` + managedMark + `
#
# Runs inside the container before ComfyUI starts (the image sources
# /root/user-scripts/pre-start.sh). The console rewrites this file while the
# line above is present; remove that line to keep it yourself.

# ComfyUI-Manager: let "Install via Git URL" work from its own interface.
#
# The Manager gates that action on the config flag allow_git_url_install
# (the console sets it) and on ComfyUI listening on a loopback address. The
# second is the wrong test in a container -- ComfyUI must bind 0.0.0.0 for
# anything outside to reach it, and the loopback it could bind is the
# container's own. The console's login in front of this UI is what actually
# gates it. The Manager updates itself and would put the check back, so it
# is dropped again on every start; sed matches the exact line, so a Manager
# that has moved the check is left as it is.
MANAGER=/root/ComfyUI/custom_nodes/ComfyUI-Manager/glob/manager_server.py
if [ -f "$MANAGER" ]; then
    sed -i 's/^    return bool(flag_value) and is_loopback(listen_address)$/    return bool(flag_value)  # loopback check dropped by pre-start.sh: the console login gates this UI/' "$MANAGER"
    if grep -q 'loopback check dropped by pre-start.sh' "$MANAGER"; then
        echo "[pre-start] ComfyUI-Manager: git-url install gated on config flag only"
    else
        echo "[pre-start] ComfyUI-Manager: install gate not where expected; left untouched"
    fi
fi

# Intel only: comfy_kitchen's triton backend cannot build several of its
# kernels for Arc (the SPIR-V link fails on bf16), and it is the backend the
# registry prefers, so the failure surfaces as a build error at the first
# quantised matmul. eager does the same work and was measured correct on a
# B70. On other vendors triton is the fast path and is left in place.
python3 - <<'PY'
try:
    import torch
    xpu = getattr(torch, "xpu", None)
    if not (xpu and xpu.is_available()):
        raise SystemExit
    import comfy_kitchen.registry as R
    R.disable("triton")
    print(f"[pre-start] comfy_kitchen: triton disabled on XPU, int8_linear -> {R.get_capable_backend('int8_linear')}")
except SystemExit:
    pass
except Exception as exc:
    print(f"[pre-start] comfy_kitchen: nothing to do ({exc})")
PY

# TenkStack model fetch: missing models downloaded by this server rather than
# by the browser. The console writes it into the shared user storage; linked
# rather than copied so a console update reaches the instance on its next
# start. A directory of that name somebody put there by hand is left alone.
FETCH=/root/user-scripts/tenkstack-nodes/tenkstack_fetch
LINK=/root/ComfyUI/custom_nodes/tenkstack_fetch
if [ -d "$FETCH" ] && { [ -L "$LINK" ] || [ ! -e "$LINK" ]; }; then
    ln -sfn "$FETCH" "$LINK"
    echo "[pre-start] TenkStack model fetch linked"
fi
`

// Seed writes the pre-start hook and the Manager flag into the shared user
// storage. Safe to call at every start and before every instance is made.
func (m *Manager) Seed() {
	user := filepath.Join(m.ComfyDir, "storage-user")
	if err := m.seedPreStart(filepath.Join(user, "user-scripts", "pre-start.sh")); err != nil {
		log.Printf("could not write the ComfyUI pre-start hook: %v", err)
	}
	if err := seedManagerFlag(filepath.Join(user, "user-profile", "__manager", "config.ini")); err != nil {
		log.Printf("could not set allow_git_url_install for ComfyUI-Manager: %v", err)
	}
	if err := seedFetchNode(filepath.Join(user, "user-scripts", filepath.FromSlash(fetchNodeDir))); err != nil {
		log.Printf("could not write the ComfyUI model-fetch extension: %v", err)
	}
}

// seedFetchNode writes the extension's files, each only when it differs, so
// a start that changes nothing touches nothing ComfyUI is watching.
func seedFetchNode(dir string) error {
	return fs.WalkDir(fetchNode, "fetchnode", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		content, err := fetchNode.ReadFile(p)
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(p, "fetchnode/")
		target := filepath.Join(dir, filepath.FromSlash(rel))
		if current, err := os.ReadFile(target); err == nil && bytes.Equal(current, content) {
			return nil
		}
		return writeFile(target, content, 0o644)
	})
}

func (m *Manager) seedPreStart(path string) error {
	current, err := os.ReadFile(path)
	switch {
	case err == nil && string(current) == preStart:
		return nil
	case err == nil && !strings.Contains(string(current), managedMark):
		// Somebody's own hook. Said once per start so it is not a mystery
		// why a fresh Manager refuses git URLs on this machine.
		log.Printf("%s is not the console's; leaving it alone", path)
		return nil
	case err != nil && !os.IsNotExist(err):
		return err
	}
	return writeFile(path, []byte(preStart), 0o755)
}

// seedManagerFlag adds allow_git_url_install under [default], creating the
// file when the Manager has not written one yet. The Manager fills in the
// rest of its defaults on first read and rewrites the whole file on any
// change made in its UI, so a minimal file is enough.
func seedManagerFlag(path string) error {
	current, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err != nil {
		return writeFile(path, []byte("[default]\nallow_git_url_install = True\n"), 0o644)
	}
	lines := strings.Split(string(current), "\n")
	section := ""
	for _, line := range lines {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "[") && strings.HasSuffix(t, "]") {
			section = strings.ToLower(strings.Trim(t, "[]"))
			continue
		}
		if section == "default" {
			if key, _, ok := strings.Cut(t, "="); ok && strings.TrimSpace(key) == "allow_git_url_install" {
				return nil
			}
		}
	}
	// Insert right under [default], or append the section when the file
	// has none.
	out := make([]string, 0, len(lines)+2)
	inserted := false
	for _, line := range lines {
		out = append(out, line)
		if !inserted && strings.EqualFold(strings.TrimSpace(line), "[default]") {
			out = append(out, "allow_git_url_install = True")
			inserted = true
		}
	}
	if !inserted {
		text := strings.TrimRight(string(current), "\n")
		if text != "" {
			text += "\n"
		}
		return writeFile(path, []byte(text+"[default]\nallow_git_url_install = True\n"), 0o644)
	}
	return writeFile(path, []byte(strings.Join(out, "\n")), 0o644)
}

// writeFile lands the content in one rename, so a container starting while
// the console writes never sources half a script. The rename also gets past
// a root-owned file left by an earlier hand-written version: the directory
// is the console's even when the file is not.
func writeFile(path string, content []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, content, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
