package gguf

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// Description is what one model's GGUF says about itself, across parts.
type Description struct {
	Architecture    string           `json:"architecture"`
	Name            any              `json:"name"`
	Layers          any              `json:"layers"`
	AttentionLayers int              `json:"attention_layers"`
	EmbeddingLength any              `json:"embedding_length"`
	HeadCount       any              `json:"head_count"`
	HeadCountKV     any              `json:"head_count_kv"`
	KeyLength       any              `json:"key_length"`
	ValueLength     any              `json:"value_length"`
	ContextLength   any              `json:"context_length"`
	MTP             bool             `json:"mtp"`
	ExpertCount     int64            `json:"expert_count"`
	ExpertUsedCount int64            `json:"expert_used_count"`
	RoutedBytes     int64            `json:"routed_bytes"`
	DenseBytes      int64            `json:"dense_bytes"`
	ByType          map[string]int64 `json:"by_type"`
	UnknownTypes    []string         `json:"unknown_types"`
}

// ByTypeOrdered is by_type largest first, which is what the file mostly is.
func (d *Description) ByTypeOrdered() []struct {
	Label string
	Bytes int64
} {
	out := make([]struct {
		Label string
		Bytes int64
	}, 0, len(d.ByType))
	for k, v := range d.ByType {
		out = append(out, struct {
			Label string
			Bytes int64
		}{k, v})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Bytes != out[j].Bytes {
			return out[i].Bytes > out[j].Bytes
		}
		return out[i].Label < out[j].Label
	})
	return out
}

// Remote reads headers over HTTP, without downloading the model. Headers
// do not change, so one read per file lasts the life of the process.
type Remote struct {
	http *http.Client

	mu   sync.Mutex
	seen map[string]*Description // nil entry: known unreadable
}

func NewRemote() *Remote {
	return &Remote{http: &http.Client{Timeout: 60 * time.Second}, seen: map[string]*Description{}}
}

func (r *Remote) readHead(ctx context.Context, url string, span int) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=0-%d", span-1))
	resp, err := r.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, int64(span)))
}

func toInt(v any) int64 {
	f, ok := number(v)
	if !ok {
		return 0
	}
	return int64(f)
}

// Describe reads the first part for metadata and every part for its
// tensor directory. Nil means the header could not be read.
func (r *Remote) Describe(ctx context.Context, repoID string, parts []string) *Description {
	key := repoID + "\x00" + strings.Join(parts, "\x00")
	r.mu.Lock()
	cached, ok := r.seen[key]
	r.mu.Unlock()
	if ok {
		return cached
	}
	remember := func(d *Description) *Description {
		r.mu.Lock()
		r.seen[key] = d
		r.mu.Unlock()
		return d
	}
	base := "https://huggingface.co/" + repoID + "/resolve/main/"
	var head *Header
	totals := Description{ByType: map[string]int64{}}
	unknown := map[string]bool{}
	for index, part := range parts {
		span := 1 << 20
		if index == 0 {
			span = FirstRead
		}
		var parsed *Header
		for _, attempt := range []int{span, WiderRead} {
			blob, err := r.readHead(ctx, base+part, attempt)
			if err != nil {
				log.Printf("GGUF header for %s/%s failed: %v", repoID, part, err)
				return remember(nil)
			}
			parsed, err = Parse(blob)
			if err == nil {
				break
			}
			if !errors.Is(err, ErrShort) {
				log.Printf("GGUF header for %s/%s failed: %v", repoID, part, err)
				return remember(nil)
			}
			parsed = nil
		}
		if parsed == nil {
			log.Printf("GGUF header for %s/%s did not fit in %d bytes", repoID, part, WiderRead)
			return remember(nil)
		}
		if index == 0 {
			head = parsed
		}
		totals.RoutedBytes += parsed.RoutedBytes
		totals.DenseBytes += parsed.DenseBytes
		totals.AttentionLayers += parsed.AttentionLayers
		totals.MTP = totals.MTP || parsed.MTP
		for label, size := range parsed.ByType {
			totals.ByType[label] += size
		}
		for _, u := range parsed.UnknownTypes {
			unknown[u] = true
		}
	}
	if head == nil {
		return remember(nil)
	}
	arch, _ := head.Meta["general.architecture"].(string)
	field := func(name string) any { return plain(head.Meta[arch+"."+name]) }
	d := &Description{
		Architecture: arch, Name: plain(head.Meta["general.name"]),
		Layers: field("block_count"), AttentionLayers: totals.AttentionLayers,
		EmbeddingLength: field("embedding_length"), HeadCount: field("attention.head_count"),
		HeadCountKV: field("attention.head_count_kv"), KeyLength: field("attention.key_length"),
		ValueLength: field("attention.value_length"), ContextLength: field("context_length"),
		MTP: totals.MTP, ExpertCount: toInt(head.Meta[arch+".expert_count"]),
		ExpertUsedCount: toInt(head.Meta[arch+".expert_used_count"]),
		RoutedBytes:     totals.RoutedBytes, DenseBytes: totals.DenseBytes, ByType: totals.ByType,
		UnknownTypes: []string{},
	}
	for u := range unknown {
		d.UnknownTypes = append(d.UnknownTypes, u)
	}
	sort.Strings(d.UnknownTypes)
	return remember(d)
}

// plain renders a metadata value the way JSON would carry it from Python:
// integers as integers, floats as floats, strings as strings.
func plain(v any) any {
	switch x := v.(type) {
	case nil:
		return nil
	case string:
		return x
	case bool:
		return x
	case float32:
		return float64(x)
	case float64:
		return x
	}
	if f, ok := number(v); ok {
		return int64(f)
	}
	return v
}
