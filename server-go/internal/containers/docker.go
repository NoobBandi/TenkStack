package containers

import (
	"bufio"
	"context"
	"log"
	"os/exec"
	"strings"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
)

// Command runs one docker command and returns its stdout. The verbs the
// console uses are fixed by their callers; nothing here takes a free-form
// command from a request.
func (d *Docker) Command(ctx context.Context, args ...string) (string, bool) {
	return d.run(ctx, args...)
}

// Pull runs docker pull, counting layers into progress.
func (d *Docker) Pull(ctx context.Context, image string, progress api.Progress) bool {
	cmd := exec.CommandContext(ctx, "docker", "pull", image)
	out, err := cmd.StdoutPipe()
	if err != nil {
		progress.Failed(err.Error())
		return false
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		progress.Failed(err.Error())
		return false
	}
	total, done := 0, 0
	sc := bufio.NewScanner(out)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		switch {
		case strings.HasSuffix(line, "Pulling fs layer"):
			total++
			progress.Layer(done, total)
		case strings.HasSuffix(line, "Pull complete") || strings.HasSuffix(line, "Already exists"):
			done++
			progress.Layer(done, total)
		case line != "":
			if len(line) > 200 {
				line = line[:200]
			}
			progress.Message(line)
		}
	}
	if err := cmd.Wait(); err != nil {
		progress.Failed("")
		return false
	}
	return true
}

// RemoveImage runs docker rmi, logging rather than failing when the image
// is still in use.
func (d *Docker) RemoveImage(ctx context.Context, image string) bool {
	_, ok := d.run(ctx, "rmi", image)
	if !ok {
		log.Printf("could not remove %s", image)
	}
	return ok
}

// PublishedPorts are the host ports the ComfyUI containers publish, running
// ones only.
func (d *Docker) PublishedPorts(ctx context.Context, prefix string) []int {
	listing, _ := d.run(ctx, "ps", "--filter", "name="+prefix, "--format", "{{.Ports}}")
	var out []int
	for _, m := range published.FindAllStringSubmatch(listing, -1) {
		n := 0
		for _, ch := range m[1] {
			n = n*10 + int(ch-'0')
		}
		out = append(out, n)
	}
	return out
}
