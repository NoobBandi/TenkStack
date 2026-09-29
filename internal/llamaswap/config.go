// Package llamaswap reads and writes llama-swap's config.yaml without losing
// what a person wrote in it: comments, order, blank lines, block scalars.
package llamaswap

import (
	"bytes"
	"os"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

type Config struct {
	doc yaml.Node
}

func Load(path string) (*Config, error) {
	src, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return Parse(src)
}

func Parse(src []byte) (*Config, error) {
	c := &Config{}
	if err := yaml.Unmarshal(protectBlanks(src), &c.doc); err != nil {
		return nil, err
	}
	stripMarkers(&c.doc)
	if len(c.doc.Content) == 0 {
		c.doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode}}}
	}
	return c, nil
}

func (c *Config) Bytes() ([]byte, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&c.doc); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return restoreBlanks(buf.Bytes()), nil
}

// Save replaces the file atomically, so no reader sees half of it.
func (c *Config) Save(path string) error {
	out, err := c.Bytes()
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, out, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (c *Config) Root() *Mapping {
	return &Mapping{c.doc.Content[0]}
}

// yaml.v3 keeps a blank line only when it touches a comment. Each blank line
// becomes a marker comment carrying the indentation of the next line, so it
// is a comment outside a block scalar and content inside one; both survive
// the encoder and are turned back afterwards.
const blankMarker = "#__blank__"

func protectBlanks(src []byte) []byte {
	lines := bytes.Split(src, []byte("\n"))
	for i, line := range lines {
		if len(bytes.TrimSpace(line)) != 0 || i == len(lines)-1 {
			continue
		}
		var indent []byte
		for _, next := range lines[i+1:] {
			if t := bytes.TrimLeft(next, " "); len(t) != 0 {
				indent = next[:len(next)-len(t)]
				break
			}
		}
		lines[i] = append(append([]byte{}, indent...), blankMarker...)
	}
	return bytes.Join(lines, []byte("\n"))
}

// Inside a block scalar the marker is content, so it has to come out of the
// parsed value too. Folded (`>`) scalars are not handled; nothing here writes
// them.
func stripMarkers(n *yaml.Node) {
	if n.Kind == yaml.ScalarNode {
		if strings.Contains(n.Value, blankMarker) {
			lines := strings.Split(n.Value, "\n")
			for i, l := range lines {
				if strings.TrimSpace(l) == blankMarker {
					lines[i] = ""
				}
			}
			n.Value = strings.Join(lines, "\n")
		}
		return
	}
	for _, c := range n.Content {
		stripMarkers(c)
	}
}

func restoreBlanks(out []byte) []byte {
	lines := bytes.Split(out, []byte("\n"))
	for i, line := range lines {
		if bytes.Equal(bytes.TrimSpace(line), []byte(blankMarker)) {
			lines[i] = nil
		}
	}
	return bytes.Join(lines, []byte("\n"))
}

// Mapping is a view over a YAML mapping node.
type Mapping struct {
	n *yaml.Node
}

func (m *Mapping) Node() *yaml.Node { return m.n }

func (m *Mapping) index(key string) int {
	if m == nil || m.n == nil {
		return -1
	}
	for i := 0; i+1 < len(m.n.Content); i += 2 {
		if m.n.Content[i].Value == key {
			return i
		}
	}
	return -1
}

func (m *Mapping) Has(key string) bool { return m.index(key) >= 0 }

func (m *Mapping) Get(key string) *yaml.Node {
	i := m.index(key)
	if i < 0 {
		return nil
	}
	return m.n.Content[i+1]
}

func (m *Mapping) Keys() []string {
	if m == nil || m.n == nil {
		return nil
	}
	keys := make([]string, 0, len(m.n.Content)/2)
	for i := 0; i+1 < len(m.n.Content); i += 2 {
		keys = append(keys, m.n.Content[i].Value)
	}
	return keys
}

// Map returns the nested mapping under key, or nil when absent or not one.
func (m *Mapping) Map(key string) *Mapping {
	n := m.Get(key)
	if n == nil || n.Kind != yaml.MappingNode {
		return nil
	}
	return &Mapping{n}
}

// EnsureMap returns the nested mapping under key, creating it if needed. A
// value of another kind is replaced.
func (m *Mapping) EnsureMap(key string) *Mapping {
	if sub := m.Map(key); sub != nil {
		return sub
	}
	n := &yaml.Node{Kind: yaml.MappingNode}
	m.Set(key, n)
	return &Mapping{n}
}

// Set replaces the value under key, keeping the key node and its comments,
// or appends a new pair.
func (m *Mapping) Set(key string, v *yaml.Node) {
	if i := m.index(key); i >= 0 {
		m.n.Content[i+1] = v
		return
	}
	m.n.Content = append(m.n.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: key}, v)
}

func (m *Mapping) Delete(key string) bool {
	i := m.index(key)
	if i < 0 {
		return false
	}
	m.n.Content = append(m.n.Content[:i], m.n.Content[i+2:]...)
	return true
}

func Str(s string) *yaml.Node {
	n := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: s}
	if s == "" {
		n.Style = yaml.SingleQuotedStyle // a bare `key:` reads back as null
	}
	return n
}

func Int(i int) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!int", Value: strconv.Itoa(i)}
}

func Bool(b bool) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: strconv.FormatBool(b)}
}

// Literal is a `|` block scalar, which is how commands stay readable by hand.
func Literal(s string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: s, Style: yaml.LiteralStyle}
}

func Seq(items ...string) *yaml.Node {
	n := &yaml.Node{Kind: yaml.SequenceNode}
	for _, s := range items {
		n.Content = append(n.Content, Str(s))
	}
	return n
}

// Strings reads a sequence of scalars; anything else yields nil.
func Strings(n *yaml.Node) []string {
	if n == nil || n.Kind != yaml.SequenceNode {
		return nil
	}
	out := make([]string, 0, len(n.Content))
	for _, c := range n.Content {
		if c.Kind == yaml.ScalarNode {
			out = append(out, c.Value)
		}
	}
	return out
}

// Scalar reads a scalar's text, or "" for anything else.
func Scalar(n *yaml.Node) string {
	if n == nil || n.Kind != yaml.ScalarNode {
		return ""
	}
	return n.Value
}
