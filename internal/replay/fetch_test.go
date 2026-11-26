package replay

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func storedChunks(t *testing.T, o *memoryObjects, n int) []Chunk {
	t.Helper()
	chunks := make([]Chunk, n)
	for i := range chunks {
		raw := []byte(fmt.Sprintf("chunk-%d", i))
		gz, err := compressReplay(raw)
		if err != nil {
			t.Fatal(err)
		}
		key := fmt.Sprintf("k%d", i)
		o.data[key] = gz
		chunks[i] = Chunk{Key: key, Checksum: checksum(raw), Ready: i != 3}
	}
	return chunks
}

func TestFetchAllKeepsOrderAndSkipsNotReady(t *testing.T) {
	o := &memoryObjects{data: map[string][]byte{}}
	chunks := storedChunks(t, o, 20)
	raws, err := NewService(nil, o).fetchAll(context.Background(), chunks)
	if err != nil {
		t.Fatal(err)
	}
	for i, raw := range raws {
		want := fmt.Sprintf("chunk-%d", i)
		if i == 3 {
			want = ""
		}
		if string(raw) != want {
			t.Fatalf("chunk %d = %q, want %q", i, raw, want)
		}
	}
}

func TestFetchAllRejectsChecksumMismatch(t *testing.T) {
	o := &memoryObjects{data: map[string][]byte{}}
	chunks := storedChunks(t, o, 5)
	chunks[2].Checksum = "bad"
	if _, err := NewService(nil, o).fetchAll(context.Background(), chunks); !errors.Is(err, ErrConflict) {
		t.Fatalf("err = %v, want ErrConflict", err)
	}
}
