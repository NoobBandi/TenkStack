package gpu

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"math"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const DefaultTimeout = 5 * time.Second

// Run executes a vendor CLI and returns its exit code and output. Failures
// are returned rather than raised: a missing tool is the normal answer on
// two of the three vendors. On a non-zero exit the output is stderr.
func Run(ctx context.Context, timeout time.Duration, name string, args ...string) (int, string) {
	if _, err := exec.LookPath(name); err != nil {
		return 127, ""
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		log.Printf("%s timed out after %s", name, timeout)
		return 124, ""
	}
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return exit.ExitCode(), stderr.String()
		}
		return 127, ""
	}
	return 0, stdout.String()
}

// RunJSON runs a CLI and decodes its stdout, numbers kept as json.Number so
// a vendor's "0" and 0 stay distinguishable.
func RunJSON(ctx context.Context, name string, args ...string) (any, bool) {
	code, out := Run(ctx, DefaultTimeout, name, args...)
	if code != 0 {
		return nil, false
	}
	dec := json.NewDecoder(strings.NewReader(out))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, false
	}
	return v, true
}

// ToFloat is a tolerant numeric read. Vendor CLIs mark an unmeasured field
// as "N/A", "[Not Supported]", an empty string or an unsigned -1, and every
// one of those must become nil rather than a number on a chart.
func ToFloat(v any) *float64 {
	var n float64
	switch x := v.(type) {
	case nil, bool:
		return nil
	case float64:
		n = x
	case int:
		n = float64(x)
	case int64:
		n = float64(x)
	case json.Number:
		f, err := x.Float64()
		if err != nil {
			return nil
		}
		n = f
	default:
		text := strings.TrimSpace(Text(v))
		upper := strings.ToUpper(text)
		if text == "" || strings.HasPrefix(upper, "N/A") || strings.HasPrefix(upper, "[NOT") || strings.HasPrefix(upper, "UNKNOWN") {
			return nil
		}
		first := strings.Fields(text)[0]
		f, err := strconv.ParseFloat(first, 64)
		if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
			return nil
		}
		n = f
	}
	if n == 4294967295 {
		return nil
	}
	return &n
}

// Text renders a decoded JSON value the way Python's str() would, which is
// what the detail rows were written against.
func Text(v any) string {
	switch x := v.(type) {
	case nil:
		return "None"
	case string:
		return x
	case json.Number:
		return x.String()
	case bool:
		if x {
			return "True"
		}
		return "False"
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	default:
		b, _ := json.Marshal(x)
		return string(b)
	}
}

func Float(f float64) *float64 { return &f }

func Str(s string) *string { return &s }

// OptStr is a JSON string field, nil when absent, null or not a string.
func OptStr(m map[string]any, key string) *string {
	if s, ok := m[key].(string); ok {
		return &s
	}
	return nil
}

// Dig walks nested maps and reads the leaf as a number; a missing step is
// nil.
func Dig(v any, path ...string) *float64 {
	cur := v
	for _, key := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur, ok = m[key]
		if !ok {
			return nil
		}
	}
	return ToFloat(cur)
}
