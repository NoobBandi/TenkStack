// Package nvidia reads cards through nvidia-smi: one --query-gpu call
// returns every field the console draws. Peak memory bandwidth is the one
// number it cannot answer; that comes from the CUDA driver.
package nvidia

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/NoobBandi/TenkStack/internal/api"
	"github.com/NoobBandi/TenkStack/internal/gpu"
)

const bin = "nvidia-smi"

// Column order of the reply. enforced.power.limit is what the card holds
// itself to; clocks.max.sm gives the busy heuristic its denominator.
var query = []string{
	"index", "name", "power.draw", "enforced.power.limit", "memory.used", "memory.total",
	"utilization.memory", "clocks.current.sm", "clocks.max.sm", "temperature.gpu",
	"temperature.gpu.tlimit",
}

type field struct{ key, label, unit string }

type group struct {
	title  string
	fields []field
}

// Same headings and order as the Intel provider, so two cards read against
// each other. Units are put back here because the query strips them.
var detailGroups = []group{
	{"識別", []field{{"name", "型號", ""}, {"compute_cap", "運算能力", ""}, {"uuid", "UUID", ""}, {"serial", "序號", ""}}},
	{"記憶體", []field{{"memory.total", "容量", "MiB"}, {"clocks.max.memory", "最高時脈", "MHz"}}},
	{"時脈與功耗", []field{{"clocks.max.sm", "最高 SM 時脈", "MHz"}, {"enforced.power.limit", "功耗上限", "W"}}},
	{"驅動與韌體", []field{{"driver_version", "驅動版本", ""}, {"vbios_version", "VBIOS", ""}, {"persistence_mode", "持續模式", ""}}},
}

const busID = "pci.bus_id"

// rowValue is one display value, or "" for a field this card does not
// answer: "N/A", "[Not Supported]", or a bracketed deprecation sentence.
func rowValue(raw string, unit string) string {
	text := strings.TrimSpace(raw)
	upper := strings.ToUpper(text)
	if text == "" || strings.HasPrefix(text, "[") || strings.HasPrefix(upper, "N/A") || strings.HasPrefix(upper, "UNKNOWN") {
		return ""
	}
	if unit != "" && strings.HasSuffix(text, ".00") {
		text = strings.TrimSuffix(text, ".00")
	}
	if unit != "" {
		return text + " " + unit
	}
	return text
}

func queryGPU(ctx context.Context, fields []string, index *int) [][]string {
	args := []string{"--query-gpu=" + strings.Join(fields, ","), "--format=csv,noheader,nounits"}
	if index != nil {
		args = append(args, "--id="+strconv.Itoa(*index))
	}
	code, out := gpu.Run(ctx, gpu.DefaultTimeout, bin, args...)
	if code != 0 {
		return nil
	}
	var rows [][]string
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		cells := strings.Split(line, ",")
		for i := range cells {
			cells[i] = strings.TrimSpace(cells[i])
		}
		rows = append(rows, cells)
	}
	return rows
}

type Nvidia struct{}

func New() *Nvidia { return &Nvidia{} }

func (*Nvidia) Key() string   { return "nvidia" }
func (*Nvidia) Label() string { return "NVIDIA (nvidia-smi)" }

func (*Nvidia) Discover(ctx context.Context) ([]gpu.Device, error) {
	var out []gpu.Device
	for _, row := range queryGPU(ctx, []string{"index", "name", "pci.bus_id", "uuid"}, nil) {
		if len(row) < 2 {
			continue
		}
		index := 0
		if n := gpu.ToFloat(row[0]); n != nil {
			index = int(*n)
		}
		d := gpu.Device{Index: index, Name: gpu.Str(row[1]), Raw: map[string]any{"uuid": nil}}
		if len(row) > 2 {
			d.PCIBDFAddress = gpu.Str(row[2])
		}
		if len(row) > 3 {
			d.Raw["uuid"] = row[3]
		}
		out = append(out, d)
	}
	return out, nil
}

func (n *Nvidia) Sample(ctx context.Context, index int) (*api.GpuSample, error) {
	rows := queryGPU(ctx, query, &index)
	if len(rows) == 0 {
		return nil, nil
	}
	row := rows[0]
	for len(row) < len(query) {
		row = append(row, "")
	}
	used, total := gpu.ToFloat(row[4]), gpu.ToFloat(row[5])
	var util *float64
	if used != nil && total != nil && *used != 0 && *total != 0 {
		util = gpu.Float(*used / *total * 100)
	}
	name := row[1]
	if name == "" {
		name = gpu.FallbackName("gpu", index)
	}
	return &api.GpuSample{
		Index:          index,
		Name:           name,
		PowerW:         gpu.ToFloat(row[2]),
		MemoryUsedMiB:  used,
		MemoryTotalMiB: total,
		// utilization.memory is bus busy time, not fullness, so it is derived.
		MemoryUtilPercent: util,
		FrequencyMHz:      gpu.ToFloat(row[7]),
		TemperatureC:      gpu.ToFloat(row[9]),
		PowerCapW:         gpu.ToFloat(row[3]),
		FrequencyMaxMHz:   gpu.ToFloat(row[8]),
		TemperatureCritC:  gpu.ToFloat(row[10]),
		Vendor:            n.Key(),
	}, nil
}

func (n *Nvidia) Detail(ctx context.Context, index int) (*api.GpuDetail, error) {
	var fields []string
	for _, g := range detailGroups {
		for _, f := range g.fields {
			fields = append(fields, f.key)
		}
	}
	fields = append(fields, busID)
	rows := queryGPU(ctx, fields, &index)
	if len(rows) == 0 {
		return nil, nil
	}
	answers := map[string]any{}
	for i, key := range fields {
		if i < len(rows[0]) {
			answers[key] = rows[0][i]
		}
	}
	address, _ := answers[busID].(string)
	peak := bandwidth(address)

	groups := []api.DetailGroup{}
	for _, g := range detailGroups {
		var entries []api.DetailRow
		for _, f := range g.fields {
			raw, _ := answers[f.key].(string)
			if v := rowValue(raw, f.unit); v != "" {
				entries = append(entries, api.DetailRow{Key: f.key, Label: f.label, Value: v})
			}
		}
		if g.title == "記憶體" && peak > 0 {
			row := api.DetailRow{Key: "memory.bandwidth", Label: "峰值頻寬", Value: fmt.Sprintf("%.0f GB/s", peak)}
			if len(entries) >= 1 {
				entries = append(entries[:1], append([]api.DetailRow{row}, entries[1:]...)...)
			} else {
				entries = append(entries, row)
			}
		}
		if len(entries) > 0 {
			groups = append(groups, api.DetailGroup{Title: g.title, Rows: entries})
		}
	}
	name, _ := answers["name"].(string)
	if name == "" {
		name = gpu.FallbackName("gpu", index)
	}
	return &api.GpuDetail{Index: index, Name: &name, Groups: groups, Raw: answers}, nil
}
