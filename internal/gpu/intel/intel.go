// Package intel reads Intel Arc cards through xpu-smi and the parts of sysfs
// it does not cover: the sustained power cap, the maximum clock, and on
// Battlemage any temperature at all.
package intel

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/NoobBandi/TenkStack/internal/api"
	"github.com/NoobBandi/TenkStack/internal/gpu"
)

const bin = "xpu-smi"

type field struct{ key, label string }

type group struct {
	title  string
	fields []field
}

var detailGroups = []group{
	{"識別", []field{
		{"device_name", "型號"}, {"vendor_name", "廠商"}, {"device_type", "類型"},
		{"sku_type", "SKU"}, {"device_stepping", "步進"}, {"serial_number", "序號"}, {"uuid", "UUID"},
	}},
	{"運算單元", []field{
		{"number_of_eus", "執行單元 (EU)"}, {"number_of_slices", "Slice"},
		{"number_of_sub_slices_per_slice", "每 Slice 的 Sub-slice"},
		{"number_of_eus_per_sub_slice", "每 Sub-slice 的 EU"},
		{"number_of_threads_per_eu", "每 EU 執行緒"}, {"physical_eu_simd_width", "SIMD 寬度"},
		{"core_clock_rate", "核心時脈"}, {"number_of_tiles", "Tile"},
	}},
	{"記憶體", []field{
		{"memory_physical_size", "容量"}, {"max_mem_alloc_size_byte", "單次配置上限"},
		{"memory_bus_width", "匯流排寬度"}, {"number_of_memory_channels", "通道數"},
		{"memory_ecc_state", "ECC"},
	}},
	{"媒體引擎", []field{
		{"number_of_media_engines", "媒體引擎"}, {"number_of_media_enh_engines", "媒體加強引擎"},
	}},
	{"驅動與韌體", []field{
		{"drm_device", "DRM 裝置"}, {"driver_version", "驅動版本"}, {"kernel_version", "核心版本"},
		{"gfx_firmware_name", "韌體"}, {"gfx_firmware_version", "韌體版本"},
		{"gfx_firmware_status", "韌體狀態"}, {"device_state", "狀態"},
	}},
}

// xpu-smi reports some fields as sentinels rather than omitting them.
func unknown(v any) bool {
	switch x := v.(type) {
	case nil:
		return true
	case string:
		return x == "" || x == "N/A" || x == "unknown" || x == "0" || x == "4294967295"
	case json.Number:
		f, _ := x.Float64()
		return f == 4294967295
	}
	return false
}

func readable(key string, v any) string {
	text := gpu.Text(v)
	if key == "max_mem_alloc_size_byte" {
		if n := gpu.ToFloat(text); n != nil && *n != 0 {
			return fmt.Sprintf("%.2f GiB", *n/(1024*1024*1024))
		}
	}
	// "32656.00 MiB", in the GiB every other memory figure here is in.
	if key == "memory_physical_size" {
		if fields := strings.Fields(text); len(fields) == 2 && fields[1] == "MiB" {
			if n := gpu.ToFloat(fields[0]); n != nil && *n != 0 {
				return fmt.Sprintf("%.1f GiB", *n/1024)
			}
		}
	}
	if key == "core_clock_rate" && isDigits(text) {
		return text + " MHz"
	}
	return text
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func readInt(path string) (int64, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	n, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	return n, err == nil
}

type sysfsExtra struct {
	powerCapW, temperatureC, temperatureCritC, frequencyMaxMHz *float64
}

// sysfs reads the limits and sensors the kernel exposes but xpu-smi does not.
func sysfs(bdf string) sysfsExtra {
	var out sysfsExtra
	if bdf == "" {
		return out
	}
	root := filepath.Join("/sys/bus/pci/devices", bdf)
	if st, err := os.Stat(root); err != nil || !st.IsDir() {
		return out
	}
	hwmons, _ := filepath.Glob(filepath.Join(root, "hwmon", "hwmon*"))
	sort.Strings(hwmons)
	for _, hw := range hwmons {
		found := false
		if cap, ok := readInt(filepath.Join(hw, "power1_cap")); ok {
			out.powerCapW = gpu.Float(float64(cap) / 1e6)
			found = true
		}
		// Only the package sensor is the die itself; the rest would be a wall
		// of numbers.
		labels, _ := filepath.Glob(filepath.Join(hw, "temp*_label"))
		sort.Strings(labels)
		for _, lp := range labels {
			b, err := os.ReadFile(lp)
			if err != nil || strings.TrimSpace(string(b)) != "pkg" {
				continue
			}
			stem := strings.TrimSuffix(lp, "_label")
			if v, ok := readInt(stem + "_input"); ok {
				out.temperatureC = gpu.Float(float64(v) / 1000)
				found = true
			}
			if v, ok := readInt(stem + "_crit"); ok {
				out.temperatureCritC = gpu.Float(float64(v) / 1000)
				found = true
			}
			break
		}
		if found {
			break
		}
	}
	if v, ok := readInt(filepath.Join(root, "tile0/gt0/freq0/rp0_freq")); ok {
		out.frequencyMaxMHz = gpu.Float(float64(v))
	}
	return out
}

type Intel struct {
	mu sync.Mutex
	// Discovery describes the card, not its state, and none of it changes
	// while the machine is up; every xpu-smi call also writes MEI errors to
	// syslog, so it is read once per card.
	static map[int]map[string]any
}

func New() *Intel { return &Intel{static: map[int]map[string]any{}} }

func (*Intel) Key() string   { return "intel" }
func (*Intel) Label() string { return "Intel (xpu-smi)" }

func obj(v any, ok bool) map[string]any {
	if !ok {
		return nil
	}
	m, _ := v.(map[string]any)
	return m
}

func (i *Intel) Discover(ctx context.Context) ([]gpu.Device, error) {
	data := obj(gpu.RunJSON(ctx, bin, "discovery", "-j"))
	if data == nil {
		return nil, nil
	}
	list, _ := data["device_list"].([]any)
	var out []gpu.Device
	for _, item := range list {
		d, _ := item.(map[string]any)
		if d == nil || d["device_type"] != "GPU" {
			continue
		}
		index := 0
		if n := gpu.ToFloat(d["device_id"]); n != nil {
			index = int(*n)
		}
		out = append(out, gpu.Device{
			Index:         index,
			Name:          gpu.OptStr(d, "device_name"),
			DRMDevice:     gpu.OptStr(d, "drm_device"),
			PCIBDFAddress: gpu.OptStr(d, "pci_bdf_address"),
			State:         gpu.OptStr(d, "device_state"),
			Raw:           d,
		})
	}
	return out, nil
}

func (i *Intel) staticFor(ctx context.Context, index int) map[string]any {
	i.mu.Lock()
	cached := i.static[index]
	i.mu.Unlock()
	if cached != nil {
		return cached
	}
	fresh := obj(gpu.RunJSON(ctx, bin, "discovery", "-d", strconv.Itoa(index), "-j"))
	if fresh == nil {
		return map[string]any{}
	}
	i.mu.Lock()
	i.static[index] = fresh
	i.mu.Unlock()
	return fresh
}

func (i *Intel) Sample(ctx context.Context, index int) (*api.GpuSample, error) {
	var (
		stats map[string]any
		disc  map[string]any
		wg    sync.WaitGroup
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		stats = obj(gpu.RunJSON(ctx, bin, "stats", "-d", strconv.Itoa(index), "-j"))
	}()
	go func() { defer wg.Done(); disc = i.staticFor(ctx, index) }()
	wg.Wait()
	if stats == nil {
		return nil, nil
	}

	var totalMiB *float64
	if raw := gpu.ToFloat(disc["memory_physical_size_byte"]); raw != nil && *raw != 0 {
		totalMiB = gpu.Float(*raw / 1024 / 1024)
	}

	bdf, _ := disc["pci_bdf_address"].(string)
	if bdf == "" {
		bdf, _ = stats["pci_bdf"].(string)
	}
	extra := sysfs(bdf)

	name := gpu.FallbackName("xpu", index)
	if s, _ := disc["device_name"].(string); s != "" {
		name = s
	}
	// xpu-smi has no temperature section for this card, but the driver does
	// publish one; sysfs is the fallback rather than the other way round.
	temp := gpu.Dig(stats, "temperature", "gpu_temperature_c", "tile_0", "current")
	if temp == nil || *temp == 0 {
		temp = extra.temperatureC
	}
	return &api.GpuSample{
		Index:             index,
		Name:              name,
		PowerW:            gpu.Dig(stats, "power", "gpu_power_w", "tile_0", "current"),
		MemoryUsedMiB:     gpu.Dig(stats, "memory", "used_mib", "tile_0", "current"),
		MemoryTotalMiB:    totalMiB,
		MemoryUtilPercent: gpu.Dig(stats, "memory", "util_percent", "tile_0", "current"),
		FrequencyMHz:      gpu.Dig(stats, "frequency", "gpu_frequency_mhz", "tile_0", "current"),
		TemperatureC:      temp,
		PowerCapW:         extra.powerCapW,
		FrequencyMaxMHz:   extra.frequencyMaxMHz,
		TemperatureCritC:  extra.temperatureCritC,
		Vendor:            i.Key(),
	}, nil
}

func (i *Intel) Detail(ctx context.Context, index int) (*api.GpuDetail, error) {
	raw := i.staticFor(ctx, index)
	if len(raw) == 0 {
		return nil, nil
	}
	groups := []api.DetailGroup{}
	for _, g := range detailGroups {
		var rows []api.DetailRow
		for _, f := range g.fields {
			v, ok := raw[f.key]
			if !ok || unknown(v) {
				continue
			}
			rows = append(rows, api.DetailRow{Key: f.key, Label: f.label, Value: readable(f.key, v)})
		}
		if len(rows) > 0 {
			groups = append(groups, api.DetailGroup{Title: g.title, Rows: rows})
		}
	}
	return &api.GpuDetail{Index: index, Name: gpu.OptStr(raw, "device_name"), Groups: groups, Raw: raw}, nil
}
