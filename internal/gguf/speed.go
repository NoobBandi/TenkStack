package gguf

import (
	"fmt"
	"math"
	"strings"
)

// Token generation is bandwidth-bound: the bytes a token reads over what
// the memory delivers, plus a fixed cost per block. Both constants were
// measured on the Arc Pro B70 rather than taken from a datasheet.
const (
	bytesPerSecond    = 568e9
	overheadPerBlock  = 9.8e-3 / 65
	kvBytesPerElement = 34.0 / 32
	vramBytes         = 32 * 1024 * 1024 * 1024
	computeReserve    = 1024 * 1024 * 1024
)

type Estimate struct {
	TokS            float64  `json:"tok_s"`
	MsPerToken      float64  `json:"ms_per_token"`
	ReadGiBPerToken float64  `json:"read_gib_per_token"`
	KVKiBPerToken   float64  `json:"kv_kib_per_token"`
	Depth           int64    `json:"depth"`
	VramGiB         float64  `json:"vram_gib"`
	Window          int64    `json:"window"`
	Fits            bool     `json:"fits"`
	Confidence      string   `json:"confidence"`
	Notes           []string `json:"notes"`
}

func roundTo(f float64, places int) float64 {
	p := math.Pow(10, float64(places))
	return math.RoundToEven(f*p) / p
}

func kvBytesPerToken(d *Description) int64 {
	layers := int64(d.AttentionLayers)
	if layers == 0 {
		layers = toInt(d.Layers)
	}
	heads := toInt(d.HeadCountKV)
	if heads == 0 {
		heads = toInt(d.HeadCount)
	}
	key := toInt(d.KeyLength)
	value := toInt(d.ValueLength)
	if value == 0 {
		value = key
	}
	if layers == 0 || heads == 0 || key == 0 {
		return 0
	}
	return int64(float64(layers*heads*(key+value)) * kvBytesPerElement)
}

// weightBytes is what one token reads: the whole file for a dense model,
// the non-expert part plus the used share of the experts for MoE.
func weightBytes(d *Description) int64 {
	if d.RoutedBytes > 0 && d.ExpertCount > 0 && d.ExpertUsedCount > 0 {
		return int64(float64(d.DenseBytes) + float64(d.RoutedBytes)*float64(d.ExpertUsedCount)/float64(d.ExpertCount))
	}
	return d.DenseBytes + d.RoutedBytes
}

// EstimateSpeed is a generation-speed estimate with what it rests on.
func EstimateSpeed(d *Description, fileBytes int64, depth int64) Estimate {
	blocks := toInt(d.Layers)
	weights := weightBytes(d)
	kv := kvBytesPerToken(d)
	resident := fileBytes
	if resident == 0 {
		resident = d.DenseBytes + d.RoutedBytes
	}
	seconds := float64(weights+depth*kv)/bytesPerSecond + float64(blocks)*overheadPerBlock
	tokS := 0.0
	if seconds > 0 {
		tokS = 1 / seconds
	}
	window := toInt(d.ContextLength)
	if window == 0 {
		window = depth
	}
	if window > 32768 {
		window = 32768
	}
	needed := float64(resident) + float64(window*kv) + computeReserve

	var typed, iq int64
	for label, size := range d.ByType {
		typed += size
		if strings.HasPrefix(label, "IQ") {
			iq += size
		}
	}
	if typed == 0 {
		typed = 1
	}
	iqShare := float64(iq) / float64(typed)
	mixed := iqShare > 0.1
	moe := d.ExpertCount > 0

	notes := []string{}
	if mixed {
		notes = append(notes, fmt.Sprintf("含 IQ 型別（約 %.0f%%），反量化成本比位元組數暗示的高：本機唯一一次這種檔案的實測比估計低 14%%。", iqShare*100))
	}
	if moe {
		notes = append(notes, fmt.Sprintf("MoE：%d 位專家中每個 token 只讀 %d 位，所以實際讀取遠小於檔案大小。本機沒有實測過 MoE，專家收集的額外開銷未計入，實際會低於這個數字。", d.ExpertCount, d.ExpertUsedCount))
	}
	if d.MTP {
		notes = append(notes, "含 MTP 推測解碼頭：開啟後實測可再快 15–65%（中文偏低、英文偏高），這個估計是關閉時的基準。")
	}
	if len(d.UnknownTypes) > 0 {
		notes = append(notes, "檔案含本程式不認識的量化型別，位元組數是估的。")
	}
	if needed > vramBytes {
		notes = append(notes, "放不進 32 GiB 顯存，部分層會落到 CPU，實際速度會遠低於此。")
	}
	confidence := "calibrated"
	switch {
	case len(d.UnknownTypes) > 0 || mixed:
		confidence = "rough"
	case moe:
		confidence = "extrapolated"
	}
	return Estimate{
		TokS: roundTo(tokS, 1), MsPerToken: roundTo(seconds*1000, 1),
		ReadGiBPerToken: roundTo(float64(weights)/(1<<30), 3), KVKiBPerToken: roundTo(float64(kv)/1024, 1),
		Depth: depth, VramGiB: roundTo(needed/(1<<30), 1), Window: window, Fits: needed <= vramBytes,
		Confidence: confidence, Notes: notes,
	}
}
