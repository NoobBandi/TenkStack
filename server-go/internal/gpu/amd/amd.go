// Package amd reads cards through amd-smi, with rocm-smi as the fallback for
// older ROCm installs. Unverified: written against the documented JSON of
// both tools, without an AMD card to run it on, so every read is tolerant
// of a missing key.
package amd

import (
	"context"
	"sort"
	"strconv"
	"strings"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
	"github.com/NoobBandi/TenkStack/server-go/internal/gpu"
)

const (
	amdSMI  = "amd-smi"
	rocmSMI = "rocm-smi"
)

// dig finds the first value under any of names, at any depth. The same
// reading sits at different depths between amd-smi releases.
func dig(v any, names ...string) any {
	switch x := v.(type) {
	case map[string]any:
		for _, name := range names {
			if val, ok := x[name]; ok {
				return val
			}
		}
		for _, key := range sortedKeys(x) {
			if found := dig(x[key], names...); found != nil {
				return found
			}
		}
	case []any:
		for _, item := range x {
			if found := dig(item, names...); found != nil {
				return found
			}
		}
	}
	return nil
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func amdJSON(ctx context.Context, args ...string) (any, bool) {
	return gpu.RunJSON(ctx, amdSMI, append(args, "--json")...)
}

func rocmJSON(ctx context.Context, args ...string) map[string]any {
	v, ok := gpu.RunJSON(ctx, rocmSMI, append(args, "--json")...)
	if !ok {
		return nil
	}
	m, _ := v.(map[string]any)
	return m
}

// entryFor picks one device out of a payload that may be a list or keyed.
func entryFor(payload any, index int) any {
	switch x := payload.(type) {
	case []any:
		for _, item := range x {
			if m, ok := item.(map[string]any); ok {
				if id := gpu.ToFloat(dig(m, "gpu", "gpu_id")); id != nil && int(*id) == index {
					return item
				}
			}
		}
		if index < len(x) {
			return x[index]
		}
		return nil
	case map[string]any:
		for _, key := range []string{"card" + strconv.Itoa(index), strconv.Itoa(index)} {
			if v, ok := x[key]; ok {
				return v
			}
		}
	}
	return payload
}

func nameOr(v any, fallback string) string {
	if v == nil {
		return fallback
	}
	return gpu.Text(v)
}

func percent(used, total *float64) *float64 {
	if used != nil && total != nil && *used != 0 && *total != 0 {
		return gpu.Float(*used / *total * 100)
	}
	return nil
}

func optStrAny(v any) *string {
	if v == nil {
		return nil
	}
	return gpu.Str(gpu.Text(v))
}

type Amd struct{}

func New() *Amd { return &Amd{} }

func (*Amd) Key() string   { return "amd" }
func (*Amd) Label() string { return "AMD (amd-smi)" }

func (*Amd) Discover(ctx context.Context) ([]gpu.Device, error) {
	if payload, ok := amdJSON(ctx, "static", "--asic"); ok {
		items, isList := payload.([]any)
		if !isList {
			items = []any{payload}
		}
		var out []gpu.Device
		for position, item := range items {
			index := position
			if id := gpu.ToFloat(dig(item, "gpu", "gpu_id")); id != nil {
				index = int(*id)
			}
			raw, _ := item.(map[string]any)
			if raw == nil {
				raw = map[string]any{}
			}
			out = append(out, gpu.Device{
				Index:         index,
				Name:          gpu.Str(nameOr(dig(item, "market_name", "product_name"), gpu.FallbackName("gpu", position))),
				PCIBDFAddress: optStrAny(dig(item, "bdf", "pci_bus")),
				Raw:           raw,
			})
		}
		return out, nil
	}
	legacy := rocmJSON(ctx, "--showproductname")
	if len(legacy) == 0 {
		return nil, nil
	}
	var out []gpu.Device
	for position, key := range sortedKeys(legacy) {
		item := legacy[key]
		raw, _ := item.(map[string]any)
		if raw == nil {
			raw = map[string]any{}
		}
		out = append(out, gpu.Device{
			Index:         position,
			Name:          gpu.Str(nameOr(dig(item, "Card series", "Card model"), key)),
			PCIBDFAddress: optStrAny(dig(item, "PCI Bus")),
			Raw:           raw,
		})
	}
	return out, nil
}

func (a *Amd) Sample(ctx context.Context, index int) (*api.GpuSample, error) {
	metric, okM := amdJSON(ctx, "metric", "--gpu", strconv.Itoa(index))
	static, okS := amdJSON(ctx, "static", "--gpu", strconv.Itoa(index))
	if !okM && !okS {
		return a.sampleLegacy(ctx, index)
	}
	m := entryFor(metric, index)
	s := entryFor(static, index)

	used := gpu.ToFloat(dig(m, "used_vram", "vram_used"))
	total := gpu.ToFloat(dig(s, "total_vram", "vram_total"))
	if total == nil || *total == 0 {
		total = gpu.ToFloat(dig(m, "total_vram"))
	}
	return &api.GpuSample{
		Index:             index,
		Name:              nameOr(dig(s, "market_name", "product_name"), gpu.FallbackName("gpu", index)),
		PowerW:            gpu.ToFloat(dig(m, "socket_power", "average_socket_power", "power")),
		MemoryUsedMiB:     used,
		MemoryTotalMiB:    total,
		MemoryUtilPercent: percent(used, total),
		FrequencyMHz:      gpu.ToFloat(dig(m, "gfxclk", "sclk", "gfx_clk")),
		TemperatureC:      gpu.ToFloat(dig(m, "edge", "hotspot", "junction", "temperature")),
		PowerCapW:         gpu.ToFloat(dig(s, "power_cap", "socket_power_cap")),
		FrequencyMaxMHz:   gpu.ToFloat(dig(s, "max_gfxclk", "sclk_max")),
		TemperatureCritC:  gpu.ToFloat(dig(s, "hotspot_limit", "temp_limit")),
		Vendor:            a.Key(),
	}, nil
}

func (a *Amd) sampleLegacy(ctx context.Context, index int) (*api.GpuSample, error) {
	data := rocmJSON(ctx, "--showpower", "--showmemuse", "--showtemp", "--showgpuclocks", "--showproductname")
	if len(data) == 0 {
		return nil, nil
	}
	item := entryFor(data, index)
	if item == nil {
		return nil, nil
	}
	used := gpu.ToFloat(dig(item, "VRAM Total Used Memory (B)"))
	total := gpu.ToFloat(dig(item, "VRAM Total Memory (B)"))
	var usedMiB, totalMiB *float64
	if used != nil && *used != 0 {
		usedMiB = gpu.Float(*used / 1024 / 1024)
	}
	if total != nil && *total != 0 {
		totalMiB = gpu.Float(*total / 1024 / 1024)
	}
	return &api.GpuSample{
		Index:             index,
		Name:              nameOr(dig(item, "Card series", "Card model"), gpu.FallbackName("gpu", index)),
		PowerW:            gpu.ToFloat(dig(item, "Average Graphics Package Power (W)")),
		MemoryUsedMiB:     usedMiB,
		MemoryTotalMiB:    totalMiB,
		MemoryUtilPercent: percent(used, total),
		FrequencyMHz:      gpu.ToFloat(dig(item, "sclk clock speed:", "sclk")),
		TemperatureC:      gpu.ToFloat(dig(item, "Temperature (Sensor edge) (C)")),
		Vendor:            a.Key(),
	}, nil
}

func (a *Amd) Detail(ctx context.Context, index int) (*api.GpuDetail, error) {
	var item map[string]any
	if payload, ok := amdJSON(ctx, "static", "--gpu", strconv.Itoa(index)); ok {
		item, _ = entryFor(payload, index).(map[string]any)
	}
	if item == nil {
		if legacy := rocmJSON(ctx, "--showallinfo"); len(legacy) > 0 {
			item, _ = entryFor(legacy, index).(map[string]any)
		}
	}
	if item == nil {
		return nil, nil
	}
	var rows []api.DetailRow
	for _, key := range sortedKeys(item) {
		value := item[key]
		switch value.(type) {
		case map[string]any, []any:
			continue
		}
		text := strings.TrimSpace(gpu.Text(value))
		upper := strings.ToUpper(text)
		if text == "" || strings.HasPrefix(upper, "N/A") || strings.HasPrefix(upper, "[NOT") {
			continue
		}
		rows = append(rows, api.DetailRow{Key: key, Label: strings.ReplaceAll(key, "_", " "), Value: text})
	}
	groups := []api.DetailGroup{}
	if len(rows) > 0 {
		groups = append(groups, api.DetailGroup{Title: "裝置", Rows: rows})
	}
	name := nameOr(dig(item, "market_name", "product_name"), gpu.FallbackName("gpu", index))
	return &api.GpuDetail{Index: index, Name: &name, Groups: groups, Raw: item}, nil
}
