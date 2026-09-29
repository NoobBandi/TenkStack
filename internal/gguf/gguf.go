// Package gguf reads GGUF headers: the metadata and the tensor directory
// that open every file, which say exactly what a model is for a few
// megabytes of a transfer that may be tens of gigabytes.
package gguf

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"os"
	"regexp"
	"strconv"
)

const (
	// The header is dominated by the tokenizer, about 6 MiB for a 150k
	// vocabulary; a parse that runs off the end is retried at the larger size.
	FirstRead = 8 << 20
	WiderRead = 40 << 20
)

// ErrShort means the header did not fit in what was read: fetch more.
var ErrShort = errors.New("gguf: header longer than the bytes read")

const (
	typeString = 8
	typeArray  = 9
)

var fixedSize = map[uint32]int{0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}

type blockSpec struct {
	name       string
	perBlock   int64
	blockBytes int64
}

// ggml tensor types: elements per block and bytes per block.
var blocks = map[uint32]blockSpec{
	0: {"F32", 1, 4}, 1: {"F16", 1, 2}, 2: {"Q4_0", 32, 18}, 3: {"Q4_1", 32, 20},
	6: {"Q5_0", 32, 22}, 7: {"Q5_1", 32, 24}, 8: {"Q8_0", 32, 34}, 9: {"Q8_1", 32, 40},
	10: {"Q2_K", 256, 84}, 11: {"Q3_K", 256, 110}, 12: {"Q4_K", 256, 144}, 13: {"Q5_K", 256, 176},
	14: {"Q6_K", 256, 210}, 15: {"Q8_K", 256, 292}, 16: {"IQ2_XXS", 256, 66}, 17: {"IQ2_XS", 256, 74},
	18: {"IQ3_XXS", 256, 98}, 19: {"IQ1_S", 256, 50}, 20: {"IQ4_NL", 32, 18}, 21: {"IQ3_S", 256, 110},
	22: {"IQ2_S", 256, 82}, 23: {"IQ4_XS", 256, 136}, 24: {"I8", 1, 1}, 25: {"I16", 1, 2},
	26: {"I32", 1, 4}, 27: {"I64", 1, 8}, 28: {"F64", 1, 8}, 29: {"IQ1_M", 256, 56},
	30: {"BF16", 1, 2}, 34: {"TQ1_0", 256, 54}, 35: {"TQ2_0", 256, 64}, 39: {"MXFP4", 32, 17},
}

// attnK is blk.7.attn_k.weight: the only reliable sign a layer keeps a KV
// cache at all.
var attnK = regexp.MustCompile(`^blk\.(\d+)\.attn_k[._]`)

// cursor is a byte reader that refuses to walk off the end. Every field is
// length-prefixed, so a truncated read shows up as ErrShort, never as a
// plausible wrong value.
type cursor struct {
	blob []byte
	at   int
}

func (c *cursor) take(n int) ([]byte, error) {
	if n < 0 || c.at+n > len(c.blob) {
		return nil, ErrShort
	}
	out := c.blob[c.at : c.at+n]
	c.at += n
	return out, nil
}

func (c *cursor) u32() (uint32, error) {
	b, err := c.take(4)
	if err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint32(b), nil
}

func (c *cursor) u64() (uint64, error) {
	b, err := c.take(8)
	if err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint64(b), nil
}

func (c *cursor) text() (string, error) {
	n, err := c.u64()
	if err != nil {
		return "", err
	}
	if n > uint64(len(c.blob)) {
		return "", ErrShort
	}
	b, err := c.take(int(n))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func (c *cursor) fixed(tag uint32) (any, error) {
	b, err := c.take(fixedSize[tag])
	if err != nil {
		return nil, err
	}
	switch tag {
	case 0:
		return uint8(b[0]), nil
	case 1:
		return int8(b[0]), nil
	case 2:
		return binary.LittleEndian.Uint16(b), nil
	case 3:
		return int16(binary.LittleEndian.Uint16(b)), nil
	case 4:
		return binary.LittleEndian.Uint32(b), nil
	case 5:
		return int32(binary.LittleEndian.Uint32(b)), nil
	case 6:
		return math.Float32frombits(binary.LittleEndian.Uint32(b)), nil
	case 7:
		return b[0] != 0, nil
	case 10:
		return binary.LittleEndian.Uint64(b), nil
	case 11:
		return int64(binary.LittleEndian.Uint64(b)), nil
	case 12:
		return math.Float64frombits(binary.LittleEndian.Uint64(b)), nil
	}
	return nil, fmt.Errorf("unknown metadata type %d", tag)
}

func (c *cursor) value(tag uint32) (any, error) {
	if _, ok := fixedSize[tag]; ok {
		return c.fixed(tag)
	}
	switch tag {
	case typeString:
		return c.text()
	case typeArray:
		inner, err := c.u32()
		if err != nil {
			return nil, err
		}
		count, err := c.u64()
		if err != nil {
			return nil, err
		}
		if inner == typeString {
			// The vocabulary and merge list: walked, not kept.
			limit := len(c.blob)
			at := c.at
			for i := uint64(0); i < count; i++ {
				if at+8 > limit {
					return nil, ErrShort
				}
				n := binary.LittleEndian.Uint64(c.blob[at:])
				if n > uint64(limit) {
					return nil, ErrShort
				}
				at += 8 + int(n)
			}
			if at > limit {
				return nil, ErrShort
			}
			c.at = at
			return fmt.Sprintf("<%d strings>", count), nil
		}
		if inner == typeArray {
			out := make([]any, 0, count)
			for i := uint64(0); i < count; i++ {
				v, err := c.value(typeArray)
				if err != nil {
					return nil, err
				}
				out = append(out, v)
			}
			return out, nil
		}
		size, ok := fixedSize[inner]
		if !ok {
			return nil, fmt.Errorf("unknown metadata type %d", inner)
		}
		if count > uint64(len(c.blob)) {
			return nil, ErrShort
		}
		raw, err := c.take(size * int(count))
		if err != nil {
			return nil, err
		}
		if count > 4096 {
			return fmt.Sprintf("<%d values>", count), nil
		}
		sub := &cursor{blob: raw}
		out := make([]any, 0, count)
		for i := uint64(0); i < count; i++ {
			v, _ := sub.fixed(inner)
			out = append(out, v)
		}
		return out, nil
	}
	return nil, fmt.Errorf("unknown metadata type %d", tag)
}

func tensorBytes(kind uint32, elements int64) (int64, bool) {
	spec, ok := blocks[kind]
	if !ok {
		return 0, false
	}
	return elements / spec.perBlock * spec.blockBytes, true
}

// Metadata reads the key/value block and leaves the cursor on the tensor
// directory.
func metadata(c *cursor) (version uint32, tensors uint64, meta map[string]any, err error) {
	magic, err := c.take(4)
	if err != nil {
		return 0, 0, nil, err
	}
	if string(magic) != "GGUF" {
		return 0, 0, nil, errors.New("not a GGUF file")
	}
	if version, err = c.u32(); err != nil {
		return
	}
	if tensors, err = c.u64(); err != nil {
		return
	}
	kv, err := c.u64()
	if err != nil {
		return
	}
	meta = map[string]any{}
	for i := uint64(0); i < kv; i++ {
		key, err := c.text()
		if err != nil {
			return 0, 0, nil, err
		}
		tag, err := c.u32()
		if err != nil {
			return 0, 0, nil, err
		}
		v, err := c.value(tag)
		if err != nil {
			return 0, 0, nil, err
		}
		meta[key] = v
	}
	return version, tensors, meta, nil
}

// Header is one file's description, as far as it describes itself.
type Header struct {
	Version         uint32
	Meta            map[string]any
	TensorCount     uint64
	RoutedBytes     int64
	DenseBytes      int64
	AttentionLayers int
	MTP             bool
	ByType          map[string]int64
	UnknownTypes    []string
	HeaderBytes     int
}

// Parse reads a header from the front of a file. ErrShort means read more.
func Parse(blob []byte) (*Header, error) {
	c := &cursor{blob: blob}
	version, tensors, meta, err := metadata(c)
	if err != nil {
		return nil, err
	}
	h := &Header{Version: version, Meta: meta, TensorCount: tensors, ByType: map[string]int64{}}
	layers := map[int]bool{}
	unknown := map[string]bool{}
	for i := uint64(0); i < tensors; i++ {
		name, err := c.text()
		if err != nil {
			return nil, err
		}
		ndims, err := c.u32()
		if err != nil {
			return nil, err
		}
		elements := int64(1)
		for d := uint32(0); d < ndims; d++ {
			dim, err := c.u64()
			if err != nil {
				return nil, err
			}
			elements *= int64(dim)
		}
		kind, err := c.u32()
		if err != nil {
			return nil, err
		}
		if _, err := c.u64(); err != nil { // offset; nothing here needs it
			return nil, err
		}
		size, known := tensorBytes(kind, elements)
		label := "type" + strconv.Itoa(int(kind))
		if known {
			label = blocks[kind].name
		} else {
			unknown[strconv.Itoa(int(kind))] = true
			size = elements * 2 // a guess, flagged as one
		}
		if regexp.MustCompile(`\.nextn\.`).MatchString(name) {
			h.MTP = true
		}
		if m := attnK.FindStringSubmatch(name); m != nil {
			n, _ := strconv.Atoi(m[1])
			layers[n] = true
		}
		h.ByType[label] += size
		// Expert tensors are named for the router: ffn_gate_exps. A shared
		// expert is ffn_gate_shexp and stays on the dense side.
		if regexp.MustCompile(`_exps`).MatchString(name) {
			h.RoutedBytes += size
		} else {
			h.DenseBytes += size
		}
	}
	h.AttentionLayers = len(layers)
	for k := range unknown {
		h.UnknownTypes = append(h.UnknownTypes, k)
	}
	sortStrings(h.UnknownTypes)
	h.HeaderBytes = c.at
	return h, nil
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// What the publisher recommends, under the names this console uses. The
// converter copies generation_config.json into general.sampling.*, and
// nothing in llama.cpp reads them back.
var samplingKeys = []struct{ key, field string }{
	{"general.sampling.temp", "temperature"},
	{"general.sampling.top_k", "top_k"},
	{"general.sampling.top_p", "top_p"},
	{"general.sampling.min_p", "min_p"},
	{"general.sampling.penalty_repeat", "repeat_penalty"},
}

func number(v any) (float64, bool) {
	switch x := v.(type) {
	case uint8:
		return float64(x), true
	case int8:
		return float64(x), true
	case uint16:
		return float64(x), true
	case int16:
		return float64(x), true
	case uint32:
		return float64(x), true
	case int32:
		return float64(x), true
	case uint64:
		return float64(x), true
	case int64:
		return float64(x), true
	case float32:
		return float64(x), true
	case float64:
		return x, true
	}
	return 0, false
}

// Sampling is the defaults one local file carries; empty is a common,
// real answer. Only the metadata block is read.
func Sampling(path string) map[string]any {
	for _, size := range []int{FirstRead, WiderRead} {
		blob, err := readHead(path, size)
		if err != nil {
			return map[string]any{}
		}
		_, _, meta, err := metadata(&cursor{blob: blob})
		if errors.Is(err, ErrShort) {
			continue
		}
		if err != nil {
			return map[string]any{}
		}
		found := map[string]any{}
		for _, s := range samplingKeys {
			if f, ok := number(meta[s.key]); ok {
				if s.field == "top_k" {
					found[s.field] = int(f)
				} else {
					found[s.field] = math.RoundToEven(f*1e4) / 1e4
				}
			}
		}
		return found
	}
	return map[string]any{}
}

func readHead(path string, size int) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, size)
	n, err := f.Read(buf)
	if err != nil && n == 0 {
		return nil, err
	}
	return buf[:n], nil
}
