package gguf

import (
	"encoding/binary"
	"testing"
)

// header is a GGUF header with one key whose value is an array of arrays
// claiming count entries.
func header(count uint64) []byte {
	b := []byte("GGUF")
	b = binary.LittleEndian.AppendUint32(b, 3)
	b = binary.LittleEndian.AppendUint64(b, 0) // tensors
	b = binary.LittleEndian.AppendUint64(b, 1) // keys
	b = binary.LittleEndian.AppendUint64(b, 1)
	b = append(b, 'k')
	b = binary.LittleEndian.AppendUint32(b, typeArray)
	b = binary.LittleEndian.AppendUint32(b, typeArray)
	return binary.LittleEndian.AppendUint64(b, count)
}

// A header comes from any repository a member names, so a count it cannot
// back must fail the parse rather than be allocated for.
func TestNestedArrayCountIsChecked(t *testing.T) {
	if _, err := Parse(header(1 << 40)); err == nil {
		t.Fatal("an impossible count should be refused")
	}
	if _, err := Parse(header(0)); err != nil {
		t.Fatalf("an empty array should parse: %v", err)
	}
}

// nested is a well-formed header whose one value is arrays nested levels
// deep, ending in an empty array of bytes.
func nested(levels int) []byte {
	b := header(1)
	for range levels - 1 {
		b = binary.LittleEndian.AppendUint32(b, typeArray)
		b = binary.LittleEndian.AppendUint64(b, 1)
	}
	b = binary.LittleEndian.AppendUint32(b, 0)
	return binary.LittleEndian.AppendUint64(b, 0)
}

func TestNestingIsBounded(t *testing.T) {
	if _, err := Parse(nested(3)); err != nil {
		t.Fatalf("shallow nesting should parse: %v", err)
	}
	if _, err := Parse(nested(100)); err == nil {
		t.Fatal("nesting a hundred deep should be refused")
	}
}
