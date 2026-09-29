package nvidia

import (
	"strings"
	"sync"

	"github.com/ebitengine/purego"
)

const (
	cuMemoryClockRate      = 36 // kHz
	cuGlobalMemoryBusWidth = 37 // bits
)

var (
	scanOnce   sync.Once
	bandwidths map[string]float64
)

// busKey folds a PCI address into the one form both tools agree on:
// nvidia-smi writes "00000000:0E:00.0", the CUDA driver "0000:0e:00.0".
func busKey(address string) string {
	parts := strings.Split(strings.ToLower(strings.TrimSpace(address)), ":")
	if len(parts) < 2 {
		return strings.ToLower(address)
	}
	return strings.Join(parts[len(parts)-2:], ":")
}

// bandwidth is the peak GB/s for a card, from the CUDA driver's memory clock
// and bus width. Loading libcuda costs a tenth of a second, so it runs once.
// A machine without libcuda gets 0.
func bandwidth(address string) float64 {
	scanOnce.Do(func() { bandwidths = scan() })
	if address == "" {
		return 0
	}
	return bandwidths[busKey(address)]
}

func scan() map[string]float64 {
	found := map[string]float64{}
	lib, err := purego.Dlopen("libcuda.so.1", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return found
	}
	var (
		cuInit               func(uint32) int32
		cuDeviceGetCount     func(*int32) int32
		cuDeviceGet          func(*int32, int32) int32
		cuDeviceGetPCIBusId  func(*byte, int32, int32) int32
		cuDeviceGetAttribute func(*int32, int32, int32) int32
	)
	for name, fn := range map[string]any{
		"cuInit": &cuInit, "cuDeviceGetCount": &cuDeviceGetCount, "cuDeviceGet": &cuDeviceGet,
		"cuDeviceGetPCIBusId": &cuDeviceGetPCIBusId, "cuDeviceGetAttribute": &cuDeviceGetAttribute,
	} {
		if _, err := purego.Dlsym(lib, name); err != nil {
			return found
		}
		purego.RegisterLibFunc(fn, lib, name)
	}
	if cuInit(0) != 0 {
		return found
	}
	var count int32
	if cuDeviceGetCount(&count) != 0 {
		return found
	}
	for ordinal := int32(0); ordinal < count; ordinal++ {
		var device int32
		if cuDeviceGet(&device, ordinal) != 0 {
			continue
		}
		buf := make([]byte, 64)
		if cuDeviceGetPCIBusId(&buf[0], int32(len(buf)), device) != 0 {
			continue
		}
		var clockKHz, widthBits int32
		if cuDeviceGetAttribute(&clockKHz, cuMemoryClockRate, device) != 0 ||
			cuDeviceGetAttribute(&widthBits, cuGlobalMemoryBusWidth, device) != 0 ||
			clockKHz == 0 || widthBits == 0 {
			continue
		}
		address := string(buf[:strings.IndexByte(string(buf), 0)])
		// Doubled because the memory is DDR; this is deviceQuery's arithmetic
		// and lands on the published figure exactly.
		found[busKey(address)] = float64(widthBits) / 8 * float64(clockKHz) * 1000 * 2 / 1e9
	}
	return found
}
