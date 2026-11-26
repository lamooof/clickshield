package replay

import (
	"context"

	"golang.org/x/sync/errgroup"
)

const fetchConcurrency = 8

// fetchAll downloads, decompresses and verifies ready chunks in parallel.
// The result is indexed like chunks; entries for not-ready chunks stay nil.
func (s *Service) fetchAll(ctx context.Context, chunks []Chunk) ([][]byte, error) {
	out := make([][]byte, len(chunks))
	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(fetchConcurrency)
	for i, c := range chunks {
		if !c.Ready {
			continue
		}
		g.Go(func() error {
			payload, err := s.objects.Get(ctx, c.Key)
			if err != nil {
				return err
			}
			raw, err := decompressReplay(payload)
			if err != nil {
				return err
			}
			if checksum(raw) != c.Checksum {
				return ErrConflict
			}
			out[i] = raw
			return nil
		})
	}
	return out, g.Wait()
}
