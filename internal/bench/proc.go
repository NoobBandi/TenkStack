package bench

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// procRoot is /proc, moved in tests.
var procRoot = "/proc"

// DescendantRSS is the resident memory, in bytes, of every process below
// the processes named parent -- llama-swap's children and theirs. It is the
// host memory of an engine that runs natively, like Strata, where there is
// no container to read it from (Q16).
func DescendantRSS(parent string) int64 {
	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return 0
	}
	children := map[int][]int{}
	var roots []int
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(procRoot, e.Name(), "stat"))
		if err != nil {
			continue
		}
		// The name is in parentheses and may hold spaces; what follows
		// the last ')' is state, then the parent's pid.
		text := string(raw)
		open, end := strings.IndexByte(text, '('), strings.LastIndexByte(text, ')')
		if open < 0 || end < open {
			continue
		}
		fields := strings.Fields(text[end+1:])
		if len(fields) < 2 {
			continue
		}
		ppid, _ := strconv.Atoi(fields[1])
		children[ppid] = append(children[ppid], pid)
		if text[open+1:end] == parent {
			roots = append(roots, pid)
		}
	}
	var total int64
	seen := map[int]bool{}
	queue := []int{}
	for _, r := range roots {
		seen[r] = true
		queue = append(queue, children[r]...)
	}
	page := int64(os.Getpagesize())
	for len(queue) > 0 {
		pid := queue[0]
		queue = queue[1:]
		if seen[pid] {
			continue
		}
		seen[pid] = true
		if raw, err := os.ReadFile(filepath.Join(procRoot, strconv.Itoa(pid), "statm")); err == nil {
			if f := strings.Fields(string(raw)); len(f) >= 2 {
				pages, _ := strconv.ParseInt(f[1], 10, 64)
				total += pages * page
			}
		}
		queue = append(queue, children[pid]...)
	}
	return total
}
