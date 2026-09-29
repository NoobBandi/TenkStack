// Package system reads host CPU, memory and disk straight from /proc and
// statfs. The GPU is only half the picture: a model that spills into RAM or
// a download with nowhere to land shows up here and nowhere else.
package system

import (
	"bufio"
	"math"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"

	"github.com/NoobBandi/TenkStack/internal/api"
)

type Sampler struct {
	modelsDir string

	// CPU utilisation is a rate, so it only exists between two readings of
	// the cumulative counters.
	mu        sync.Mutex
	prevIdle  int64
	prevTotal int64
	primed    bool
}

func New(modelsDir string) *Sampler { return &Sampler{modelsDir: modelsDir} }

func cpuCounters() (idle, total int64, ok bool) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0, 0, false
	}
	defer f.Close()
	line, _ := bufio.NewReader(f).ReadString('\n')
	fields := strings.Fields(line)
	if len(fields) == 0 || fields[0] != "cpu" {
		return 0, 0, false
	}
	var values []int64
	for _, v := range fields[1:] {
		if len(values) == 10 {
			break
		}
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			continue
		}
		values = append(values, n)
	}
	if len(values) < 5 {
		return 0, 0, false
	}
	for _, v := range values {
		total += v
	}
	return values[3] + values[4], total, true
}

func (s *Sampler) cpuPercent() *float64 {
	idle, total, ok := cpuCounters()
	if !ok {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.primed {
		// A fabricated 0% would read as an idle machine rather than as "not
		// yet known".
		s.prevIdle, s.prevTotal, s.primed = idle, total, true
		return nil
	}
	dTotal := total - s.prevTotal
	dIdle := idle - s.prevIdle
	s.prevIdle, s.prevTotal = idle, total
	if dTotal <= 0 {
		return nil
	}
	p := round1((1 - float64(dIdle)/float64(dTotal)) * 100)
	return &p
}

func meminfo() map[string]int64 {
	out := map[string]int64{}
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return out
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		key, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		parts := strings.Fields(rest)
		if len(parts) == 0 {
			continue
		}
		if n, err := strconv.ParseInt(parts[0], 10, 64); err == nil {
			out[key] = n * 1024
		}
	}
	return out
}

func cpuModel() *string {
	f, err := os.Open("/proc/cpuinfo")
	if err != nil {
		return nil
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if strings.HasPrefix(sc.Text(), "model name") {
			_, v, _ := strings.Cut(sc.Text(), ":")
			v = strings.TrimSpace(v)
			return &v
		}
	}
	return nil
}

func disk(path string) *api.SystemDisk {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return nil
	}
	frsize := int64(st.Frsize)
	total := int64(st.Blocks) * frsize
	// Three quantities: what a process may use, the root-reserved blocks,
	// and used; they sum to the total, which "used" and "available" alone
	// never did.
	free := int64(st.Bavail) * frsize
	used := total - int64(st.Bfree)*frsize
	reserved := (int64(st.Bfree) - int64(st.Bavail)) * frsize
	percent := 0.0
	if used+free > 0 {
		percent = round1(float64(used) / float64(used+free) * 100)
	}
	return &api.SystemDisk{Path: path, TotalBytes: total, UsedBytes: used, FreeBytes: free,
		ReservedBytes: reserved, Percent: percent}
}

func loadavg() []float64 {
	b, err := os.ReadFile("/proc/loadavg")
	fields := strings.Fields(string(b))
	if err != nil || len(fields) < 3 {
		return []float64{0, 0, 0}
	}
	out := make([]float64, 3)
	for i := range out {
		f, _ := strconv.ParseFloat(fields[i], 64)
		out[i] = math.RoundToEven(f*100) / 100
	}
	return out
}

func uptime() *float64 {
	b, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return nil
	}
	fields := strings.Fields(string(b))
	if len(fields) == 0 {
		return nil
	}
	f, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return nil
	}
	return &f
}

func (s *Sampler) Sample() api.SystemSample {
	mem := meminfo()
	total, available := mem["MemTotal"], mem["MemAvailable"]
	swapTotal, swapFree := mem["SwapTotal"], mem["SwapFree"]

	disks := []api.SystemDisk{}
	if root := disk("/"); root != nil {
		disks = append(disks, *root)
	}
	// The models directory only gets its own bar when it is a different
	// filesystem.
	if models := disk(s.modelsDir); models != nil && len(disks) > 0 && models.TotalBytes != disks[0].TotalBytes {
		disks = append(disks, *models)
	}

	memPercent, swapPercent := 0.0, 0.0
	if total > 0 {
		memPercent = round1(float64(total-available) / float64(total) * 100)
	}
	if swapTotal > 0 {
		swapPercent = round1(float64(swapTotal-swapFree) / float64(swapTotal) * 100)
	}
	return api.SystemSample{
		CPU: api.SystemCPU{
			Percent: s.cpuPercent(),
			Cores:   runtime.NumCPU(),
			Model:   cpuModel(),
			Load:    loadavg(),
		},
		Memory: api.SystemMemory{TotalBytes: total, AvailableBytes: available,
			UsedBytes: total - available, Percent: memPercent},
		Swap:          api.SystemSwap{TotalBytes: swapTotal, UsedBytes: swapTotal - swapFree, Percent: swapPercent},
		Disks:         disks,
		UptimeSeconds: uptime(),
	}
}

func round1(f float64) float64 { return math.RoundToEven(f*10) / 10 }
