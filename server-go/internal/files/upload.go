package files

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

func bufioReader(f *os.File) io.Reader { return bufio.NewReaderSize(f, 1<<20) }

// Receive appends one chunk, finishing the file when the declared total
// arrives. Bytes land in <name>.part and the rename happens only at the
// end, so a partial upload is never mistaken for a model. Returns the
// length actually held when the offset does not match, so the client
// re-syncs rather than starting over.
func (f *Files) Receive(rootKey, rel, name string, offset, total int64, body io.Reader) (map[string]any, error) {
	if err := f.refuseReadonly(rootKey); err != nil {
		return nil, err
	}
	target, err := f.Resolve(rootKey, rel, name)
	if err != nil {
		return nil, err
	}
	if exists(target) {
		return nil, &Exists{name}
	}
	if !writable(filepath.Dir(target)) {
		return nil, &NotWritable{filepath.Dir(target)}
	}
	part := target + PartSuffix
	var have int64
	if st, err := os.Stat(part); err == nil {
		have = st.Size()
	}
	if offset != have {
		return map[string]any{"ok": false, "expected": have}, nil
	}
	h, err := os.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	// Plain writes: these land in the page cache and nothing waits on the
	// disk.
	if _, err := io.Copy(h, body); err != nil {
		h.Close()
		return nil, err
	}
	h.Close()
	st, err := os.Stat(part)
	if err != nil {
		return nil, err
	}
	written := st.Size()
	if written < total {
		return map[string]any{"ok": true, "offset": written, "done": false}, nil
	}
	if written > total {
		os.Remove(part)
		return nil, &UploadMismatch{fmt.Sprintf("received %d bytes for a declared %d", written, total)}
	}
	if err := os.Rename(part, target); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "offset": written, "done": true}, nil
}
