package files

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/HugoSmits86/nativewebp"
	"github.com/rwcarlsen/goexif/exif"
	_ "golang.org/x/image/bmp"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"

	"github.com/NoobBandi/TenkStack/server-go/internal/api"
)

const (
	safetensorsMaxHeader = 64 << 20
	tensorLimit          = 4000
	metaStringLimit      = 2048
	thumbnailLimit       = 512 * 1024
	textHead             = 256 * 1024
	editMax              = 2 * 1024 * 1024
	thumbSize            = 320
)

var textSuffixes = map[string]bool{
	".txt": true, ".md": true, ".json": true, ".yaml": true, ".yml": true, ".toml": true, ".ini": true, ".cfg": true, ".conf": true,
	".csv": true, ".tsv": true, ".log": true, ".py": true, ".js": true, ".ts": true, ".tsx": true, ".jsx": true, ".sh": true, ".bash": true,
	".c": true, ".h": true, ".cpp": true, ".hpp": true, ".rs": true, ".go": true, ".sql": true, ".html": true, ".css": true, ".xml": true,
	".env": true, ".gitignore": true, ".service": true, ".caddyfile": true,
}

var (
	imageSuffixes = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".webp": true, ".gif": true, ".bmp": true, ".tif": true, ".tiff": true, ".avif": true}
	videoSuffixes = map[string]bool{".mp4": true, ".webm": true, ".mkv": true, ".mov": true, ".m4v": true, ".avi": true}
	audioSuffixes = map[string]bool{".mp3": true, ".wav": true, ".flac": true, ".ogg": true, ".opus": true, ".m4a": true, ".aac": true}
)

func CanThumbnail(name string) bool { return imageSuffixes[Suffix(name)] }

// MediaKind is what the preview panel should draw for this name, or nil.
// Extension rather than content: being wrong costs a broken video element,
// and reading every file's head would put an open in the listing loop.
func MediaKind(name string) any {
	suffix := Suffix(name)
	switch {
	case imageSuffixes[suffix] || suffix == ".svg":
		return "image"
	case videoSuffixes[suffix]:
		return "video"
	case audioSuffixes[suffix]:
		return "audio"
	case suffix == ".safetensors" || suffix == ".gguf":
		return "model"
	case textSuffixes[suffix]:
		return "text"
	}
	return nil
}

// trimMetadata keeps a thumbnail data URI whole and cuts the training logs.
func trimMetadata(meta map[string]any) any {
	if meta == nil {
		return nil
	}
	out := map[string]any{}
	for k, v := range meta {
		if s, ok := v.(string); ok && len([]rune(s)) > metaStringLimit {
			if strings.HasPrefix(s, "data:image/") && len(s) <= thumbnailLimit {
				out[k] = s
			} else {
				out[k] = string([]rune(s)[:metaStringLimit]) + fmt.Sprintf("…（共 %d 字元）", len([]rune(s)))
			}
			continue
		}
		out[k] = v
	}
	return out
}

func peekSafetensors(f *os.File) (map[string]any, error) {
	var lengthRaw [8]byte
	if _, err := io.ReadFull(f, lengthRaw[:]); err != nil {
		return nil, fmt.Errorf("檔案太短，不是 safetensors")
	}
	length := binary.LittleEndian.Uint64(lengthRaw[:])
	if length == 0 || length > safetensorsMaxHeader {
		return nil, fmt.Errorf("safetensors 標頭長度不合理")
	}
	raw := make([]byte, length)
	if _, err := io.ReadFull(f, raw); err != nil {
		return nil, err
	}
	var header map[string]json.RawMessage
	if err := json.Unmarshal(raw, &header); err != nil {
		return nil, err
	}
	var meta map[string]any
	if m, ok := header["__metadata__"]; ok {
		json.Unmarshal(m, &meta)
		delete(header, "__metadata__")
	}
	var tensors []map[string]any
	var params int64
	for key, rawValue := range header {
		var value struct {
			Dtype       any     `json:"dtype"`
			Shape       []int64 `json:"shape"`
			DataOffsets []int64 `json:"data_offsets"`
		}
		json.Unmarshal(rawValue, &value)
		count := int64(1)
		for _, d := range value.Shape {
			count *= d
		}
		params += count
		var size int64
		if len(value.DataOffsets) >= 2 {
			size = value.DataOffsets[1] - value.DataOffsets[0]
			if size < 0 {
				size = 0
			}
		}
		shape := value.Shape
		if shape == nil {
			shape = []int64{}
		}
		tensors = append(tensors, map[string]any{"name": key, "dtype": value.Dtype, "shape": shape, "params": count, "bytes": size})
	}
	sort.Slice(tensors, func(i, j int) bool { return tensors[i]["name"].(string) < tensors[j]["name"].(string) })
	count := len(tensors)
	if len(tensors) > tensorLimit {
		tensors = tensors[:tensorLimit]
	}
	if tensors == nil {
		tensors = []map[string]any{}
	}
	return map[string]any{"format": "safetensors", "tensors": tensors, "truncated": count > tensorLimit,
		"count": count, "parameters": params, "metadata": trimMetadata(meta)}, nil
}

var ggmlTypes = map[uint32]string{
	0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 6: "Q5_0", 7: "Q5_1", 8: "Q8_0", 9: "Q8_1", 10: "Q2_K", 11: "Q3_K", 12: "Q4_K",
	13: "Q5_K", 14: "Q6_K", 15: "Q8_K", 16: "IQ2_XXS", 17: "IQ2_XS", 18: "IQ3_XXS", 19: "IQ1_S", 20: "IQ4_NL", 21: "IQ3_S",
	22: "IQ2_S", 23: "IQ4_XS", 24: "I8", 25: "I16", 26: "I32", 27: "I64", 28: "F64", 29: "IQ1_M", 30: "BF16", 34: "TQ1_0",
	35: "TQ2_0", 39: "MXFP4",
}

type reader struct {
	r   io.Reader
	err error
}

func (r *reader) read(n int) []byte {
	if r.err != nil {
		return nil
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(r.r, b); err != nil {
		r.err = err
		return nil
	}
	return b
}

func (r *reader) u32() uint32 {
	b := r.read(4)
	if b == nil {
		return 0
	}
	return binary.LittleEndian.Uint32(b)
}

func (r *reader) u64() uint64 {
	b := r.read(8)
	if b == nil {
		return 0
	}
	return binary.LittleEndian.Uint64(b)
}

func (r *reader) str() string {
	n := r.u64()
	if r.err != nil || n > 1<<30 {
		r.err = fmt.Errorf("string too long")
		return ""
	}
	return string(bytes.ToValidUTF8(r.read(int(n)), []byte("�")))
}

// ggufValue reads one metadata value by type tag; arrays nest.
func (r *reader) ggufValue(kind uint32) (any, error) {
	switch kind {
	case 0:
		return uint8(r.read(1)[0]), r.err
	case 1:
		b := r.read(1)
		if b == nil {
			return nil, r.err
		}
		return int8(b[0]), nil
	case 2:
		return binary.LittleEndian.Uint16(padded(r.read(2), 2)), r.err
	case 3:
		return int16(binary.LittleEndian.Uint16(padded(r.read(2), 2))), r.err
	case 4:
		return r.u32(), r.err
	case 5:
		return int32(r.u32()), r.err
	case 6:
		// Widened, as Python does: 0.95 in float32 is 0.949999988079071.
		return float64(math.Float32frombits(r.u32())), r.err
	case 7:
		b := r.read(1)
		if b == nil {
			return nil, r.err
		}
		return b[0] != 0, nil
	case 8:
		return r.str(), r.err
	case 9:
		inner := r.u32()
		count := r.u64()
		if r.err != nil {
			return nil, r.err
		}
		if count > 1<<24 {
			return nil, fmt.Errorf("array too long")
		}
		out := make([]any, 0, min(count, 1<<16))
		for i := uint64(0); i < count; i++ {
			v, err := r.ggufValue(inner)
			if err != nil {
				return nil, err
			}
			if i < 33 {
				out = append(out, v)
			}
		}
		if count > 32 {
			return fmt.Sprintf("[%d 個項目]", count), nil
		}
		return out, nil
	case 10:
		return r.u64(), r.err
	case 11:
		return int64(r.u64()), r.err
	case 12:
		return math.Float64frombits(r.u64()), r.err
	}
	return nil, fmt.Errorf("unknown gguf value type %d", kind)
}

func padded(b []byte, n int) []byte {
	if b == nil {
		return make([]byte, n)
	}
	return b
}

func peekGGUF(f *os.File) (map[string]any, error) {
	r := &reader{r: bufioReader(f)}
	if string(r.read(4)) != "GGUF" {
		return nil, fmt.Errorf("不是 GGUF 檔")
	}
	version := r.u32()
	tensorCount := r.u64()
	kvCount := r.u64()
	if r.err != nil {
		return nil, r.err
	}
	meta := map[string]any{}
	for i := uint64(0); i < kvCount; i++ {
		key := r.str()
		kind := r.u32()
		if r.err != nil {
			return nil, r.err
		}
		value, err := r.ggufValue(kind)
		if err != nil {
			return nil, err
		}
		meta[key] = value
	}
	tensors := []map[string]any{}
	for i := uint64(0); i < tensorCount && i < tensorLimit; i++ {
		name := r.str()
		nDims := r.u32()
		if r.err != nil || nDims > 8 {
			break
		}
		dims := make([]uint64, nDims)
		for d := range dims {
			dims[d] = r.u64()
		}
		ggmlType := r.u32()
		offset := r.u64()
		if r.err != nil {
			break // a truncated directory is not a reason to lose the metadata
		}
		count := uint64(1)
		shape := make([]uint64, len(dims))
		for d, v := range dims {
			count *= v
			shape[len(dims)-1-d] = v // stored fastest-varying first
		}
		dtype, ok := ggmlTypes[ggmlType]
		if !ok {
			dtype = fmt.Sprintf("type%d", ggmlType)
		}
		tensors = append(tensors, map[string]any{"name": name, "shape": shape, "dtype": dtype, "params": count, "offset": offset})
	}
	return map[string]any{"format": "gguf", "version": version, "count": tensorCount, "metadata": meta,
		"tensors": tensors, "truncated": tensorCount > uint64(len(tensors))}, nil
}

// Peek is what can be said about a file without reading all of it: a
// model header, the first page of a text file, or an honest nothing.
func (f *Files) Peek(rootKey, rel, name string) (map[string]any, error) {
	target, size, err := f.OpenFile(rootKey, rel, name, false)
	if err != nil {
		return nil, err
	}
	suffix := Suffix(target)
	if suffix == ".safetensors" || suffix == ".gguf" {
		h, err := os.Open(target)
		if err != nil {
			return map[string]any{"kind": "unreadable", "size": size, "detail": err.Error()}, nil
		}
		defer h.Close()
		var out map[string]any
		if suffix == ".safetensors" {
			out, err = peekSafetensors(h)
		} else {
			out, err = peekGGUF(h)
		}
		if err != nil {
			return map[string]any{"kind": "unreadable", "size": size, "detail": err.Error()}, nil
		}
		out["kind"] = "model"
		out["size"] = size
		return out, nil
	}
	if textSuffixes[suffix] || (suffix == "" && size < textHead) {
		h, err := os.Open(target)
		if err != nil {
			return nil, err
		}
		defer h.Close()
		raw := make([]byte, textHead)
		n, _ := io.ReadFull(h, raw)
		raw = raw[:n]
		if bytes.IndexByte(raw, 0) >= 0 {
			return map[string]any{"kind": "binary", "size": size}, nil
		}
		return map[string]any{"kind": "text", "size": size, "text": string(bytes.ToValidUTF8(raw, []byte("�"))),
			"truncated": size > textHead, "language": strings.TrimPrefix(suffix, ".")}, nil
	}
	return map[string]any{"kind": "binary", "size": size}, nil
}

// Thumbnail is a small WebP of an image, made once and kept, keyed on
// path, size and mtime so a replaced file gets a new picture.
func (f *Files) Thumbnail(rootKey, rel, name string) (string, error) {
	target, size, err := f.OpenFile(rootKey, rel, name, false)
	if err != nil {
		return "", err
	}
	st, err := os.Stat(target)
	if err != nil {
		return "", &NotFound{name}
	}
	key := fmt.Sprintf("%s:%d:%d:%d", target, size, st.ModTime().UnixNano(), thumbSize)
	sum := sha256.Sum256([]byte(key))
	dir := filepath.Join(f.StateDir, "thumbs")
	cached := filepath.Join(dir, hex.EncodeToString(sum[:])[:32]+".webp")
	if exists(cached) {
		return cached, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	h, err := os.Open(target)
	if err != nil {
		return "", err
	}
	defer h.Close()
	img, _, err := image.Decode(h)
	if err != nil {
		return "", &Unreadable{err.Error()}
	}
	h.Seek(0, io.SeekStart)
	img = transpose(img, orientation(h))
	b := img.Bounds()
	w, hgt := b.Dx(), b.Dy()
	if w > thumbSize || hgt > thumbSize {
		scale := float64(thumbSize) / float64(max(w, hgt))
		nw, nh := max(1, int(float64(w)*scale)), max(1, int(float64(hgt)*scale))
		dst := image.NewNRGBA(image.Rect(0, 0, nw, nh))
		draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Over, nil)
		img = dst
	}
	staging := fmt.Sprintf("%s.%d.tmp", cached, os.Getpid())
	out, err := os.Create(staging)
	if err != nil {
		return "", err
	}
	if err := nativewebp.Encode(out, img, nil); err != nil {
		out.Close()
		os.Remove(staging)
		return "", &Unreadable{err.Error()}
	}
	out.Close()
	if err := os.Rename(staging, cached); err != nil {
		return "", err
	}
	return cached, nil
}

// Unreadable is an image the decoder could not open, worth a 415.
type Unreadable struct{ Msg string }

func (e *Unreadable) Error() string { return e.Msg }

func orientation(r io.Reader) int {
	x, err := exif.Decode(r)
	if err != nil {
		return 1
	}
	tag, err := x.Get(exif.Orientation)
	if err != nil {
		return 1
	}
	o, err := tag.Int(0)
	if err != nil {
		return 1
	}
	return o
}

// transpose applies EXIF orientation, which is why phone photos would
// otherwise arrive sideways.
func transpose(img image.Image, o int) image.Image {
	if o <= 1 || o > 8 {
		return img
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	var dst *image.NRGBA
	if o >= 5 {
		dst = image.NewNRGBA(image.Rect(0, 0, h, w))
	} else {
		dst = image.NewNRGBA(image.Rect(0, 0, w, h))
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			c := img.At(b.Min.X+x, b.Min.Y+y)
			var tx, ty int
			switch o {
			case 2:
				tx, ty = w-1-x, y
			case 3:
				tx, ty = w-1-x, h-1-y
			case 4:
				tx, ty = x, h-1-y
			case 5:
				tx, ty = y, x
			case 6:
				tx, ty = h-1-y, x
			case 7:
				tx, ty = h-1-y, w-1-x
			case 8:
				tx, ty = y, w-1-x
			}
			dst.Set(tx, ty, c)
		}
	}
	return dst
}

// ReadText is a whole text file, for editing; the mtime comes back with it
// and must be handed to WriteText.
func (f *Files) ReadText(rootKey, rel, name string) (api.FSText, error) {
	target, size, err := f.OpenFile(rootKey, rel, name, false)
	if err != nil {
		return api.FSText{}, err
	}
	if size > editMax {
		return api.FSText{}, &TooBig{fmt.Sprintf("檔案 %d KiB，超過可編輯的 %d KiB", size/1024, editMax/1024)}
	}
	raw, err := os.ReadFile(target)
	if err != nil {
		return api.FSText{}, err
	}
	if bytes.IndexByte(raw, 0) >= 0 {
		return api.FSText{}, &TooBig{"二進位檔案不能編輯"}
	}
	if !utf8Valid(raw) {
		return api.FSText{}, &TooBig{"不是 UTF-8 文字檔，無法安全編輯"}
	}
	st, _ := os.Stat(target)
	root, _ := f.root(rootKey)
	return api.FSText{Text: string(raw), Size: size, Mtime: mtime(st), Language: strings.TrimPrefix(Suffix(target), "."),
		Writable: f.canWrite(root, filepath.Dir(target))}, nil
}

func utf8Valid(b []byte) bool { return bytes.Equal(bytes.ToValidUTF8(b, []byte{0}), b) }

// WriteText replaces a text file, written beside and renamed over, and
// refused if the file changed since it was read.
func (f *Files) WriteText(rootKey, rel, name, text string, mtimeSeen *float64) (api.FSWritten, error) {
	target, err := f.Resolve(rootKey, rel, name)
	if err != nil {
		return api.FSWritten{}, err
	}
	if err := f.refuseReadonly(rootKey); err != nil {
		return api.FSWritten{}, err
	}
	st, err := os.Stat(target)
	if err != nil || !st.Mode().IsRegular() {
		return api.FSWritten{}, &NotFound{name}
	}
	if !writable(filepath.Dir(target)) {
		return api.FSWritten{}, &NotWritable{filepath.Dir(target)}
	}
	if mtimeSeen != nil && math.Abs(mtime(st)-*mtimeSeen) > 1e-6 {
		return api.FSWritten{}, &Stale{"檔案在編輯期間被其他人改過，請重新開啟"}
	}
	data := []byte(text)
	if len(data) > editMax {
		return api.FSWritten{}, &TooBig{fmt.Sprintf("內容 %d KiB，超過可儲存的 %d KiB", len(data)/1024, editMax/1024)}
	}
	tmp := filepath.Join(filepath.Dir(target), fmt.Sprintf(".%s.%d.tmp", filepath.Base(target), os.Getpid()))
	defer os.Remove(tmp)
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return api.FSWritten{}, err
	}
	// Permissions follow the file being replaced, or saving a 600 config
	// publishes it.
	os.Chmod(tmp, st.Mode().Perm())
	if err := os.Rename(tmp, target); err != nil {
		return api.FSWritten{}, err
	}
	after, _ := os.Stat(target)
	return api.FSWritten{OK: true, Size: len(data), Mtime: mtime(after)}, nil
}
