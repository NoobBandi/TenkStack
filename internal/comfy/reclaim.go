package comfy

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/NoobBandi/TenkStack/internal/vendors"
)

// Reclaim gives a directory in the ComfyUI storage, and everything under
// it, back to the console's user. ComfyUI runs as root in its container, so
// what it creates -- a subfolder of the output such as 3d/, a model a
// custom node downloaded -- belongs to root, and the console, running as
// the user, can list it but not delete, rename or move anything inside.
// A throwaway container of a ComfyUI image, root and already on the
// machine, hands the tree back. ComfyUI keeps writing there as before:
// root is not stopped by the ownership.
func (m *Manager) Reclaim(ctx context.Context, dir string) error {
	base, err := filepath.EvalSymlinks(m.ComfyDir)
	if err != nil {
		return err
	}
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(base, real)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("%s is not inside the ComfyUI storage", dir)
	}
	image := m.localImage(ctx)
	if image == "" {
		return errors.New("no ComfyUI image on this machine to change the owner with")
	}
	owner := fmt.Sprintf("%d:%d", os.Getuid(), os.Getgid())
	if out, ok := m.Docker.Command(ctx, "run", "--rm", "--network", "none", "--user", "0:0",
		"--entrypoint", "chown", "-v", real+":/reclaim", image, "-R", owner, "/reclaim"); !ok {
		return fmt.Errorf("chown in %s failed: %s", image, strings.TrimSpace(out))
	}
	return nil
}

// localImage is a ComfyUI image already pulled here, so reclaiming never
// waits on a download.
func (m *Manager) localImage(ctx context.Context) string {
	have := m.Docker.ImageSizes(ctx)
	for _, v := range vendors.All() {
		if v.Comfy == nil {
			continue
		}
		if _, ok := have[v.Comfy.Image]; ok {
			return v.Comfy.Image
		}
	}
	return ""
}
