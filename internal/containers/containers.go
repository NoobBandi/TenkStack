// Package containers lists and controls the containers this platform runs
// on. It can list, start, stop and restart; it cannot create, exec into or
// remove one, because the console's user is in the docker group and those
// verbs would be a root shell.
package containers

import (
	"bytes"
	"context"
	"log"
	"os/exec"
	"strconv"
	"strings"
)

type Docker struct{}

func New() *Docker { return &Docker{} }

func (*Docker) run(ctx context.Context, args ...string) (string, bool) {
	cmd := exec.CommandContext(ctx, "docker", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if _, missing := err.(*exec.Error); !missing {
			msg := strings.TrimSpace(stderr.String())
			if len(msg) > 200 {
				msg = msg[:200]
			}
			log.Printf("docker %s failed: %s", args[0], msg)
		}
		return "", false
	}
	return stdout.String(), true
}

// Names lists every container, running or not.
func (d *Docker) Names(ctx context.Context) []string {
	out, ok := d.run(ctx, "ps", "-a", "--format", "{{.Names}}")
	if !ok {
		return nil
	}
	return strings.Fields(out)
}

// Running is a running container's full id, which names its cgroup, and
// its host pid, which is the way into its network namespace.
type Running struct {
	ID  string
	Pid int
}

func (d *Docker) RunningIDs(ctx context.Context) map[string]Running {
	found := map[string]Running{}
	listing, ok := d.run(ctx, "ps", "--format", "{{.Names}}")
	names := strings.Fields(listing)
	if !ok || len(names) == 0 {
		return found
	}
	detail, _ := d.run(ctx, append([]string{"inspect", "-f", "{{.Name}} {{.Id}} {{.State.Pid}}"}, names...)...)
	for _, line := range strings.Split(detail, "\n") {
		parts := strings.Fields(line)
		if len(parts) != 3 {
			continue
		}
		pid, err := strconv.Atoi(parts[2])
		if err != nil {
			continue
		}
		found[strings.TrimPrefix(parts[0], "/")] = Running{ID: parts[1], Pid: pid}
	}
	return found
}

// ImageSizes maps image reference to human size for what is on this disk.
func (d *Docker) ImageSizes(ctx context.Context) map[string]string {
	found := map[string]string{}
	listing, _ := d.run(ctx, "images", "--format", "{{.Repository}}:{{.Tag}}\t{{.Size}}")
	for _, line := range strings.Split(listing, "\n") {
		name, size, ok := strings.Cut(line, "\t")
		if ok && strings.TrimSpace(name) != "" {
			found[strings.TrimSpace(name)] = strings.TrimSpace(size)
		}
	}
	return found
}

// ImageID is the content id behind a tag, or "" when the image is not
// here: what tells one pull of a rolling tag from the next.
func (d *Docker) ImageID(ctx context.Context, image string) string {
	out, _ := d.run(ctx, "images", "--no-trunc", "-q", image)
	return strings.TrimSpace(strings.SplitN(out, "\n", 2)[0])
}

var verbs = map[string]bool{"restart": true, "start": true, "stop": true}

// Control starts, stops or restarts one container that exists. Both
// arguments are checked rather than trusted.
func (d *Docker) Control(ctx context.Context, name, verb string) bool {
	if !verbs[verb] {
		return false
	}
	known := false
	for _, n := range d.Names(ctx) {
		if n == name {
			known = true
		}
	}
	if !known {
		return false
	}
	_, ok := d.run(ctx, verb, name)
	return ok
}
