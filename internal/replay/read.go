package replay

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"time"
)

func (s *Service) Replay(ctx context.Context, id string) (Data, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	result := Data{Pages: []Page{}}
	expires, chunks, err := s.repository.Load(ctx, id)
	if err != nil {
		return result, err
	}
	result.ExpiresAt = expires
	if len(chunks) > 0 && s.objects == nil {
		return result, fmt.Errorf("replay object storage is not configured")
	}
	raws, err := s.fetchAll(ctx, chunks)
	if err != nil {
		return result, err
	}
	var page *Page
	var group bytes.Buffer
	lastSeq := -1
	parts := 0
	expected := 0
	nextPart := 0
	finish := func() {
		if page == nil || lastSeq < 0 {
			return
		}
		if parts != expected || nextPart != expected {
			page.Incomplete = true
			return
		}
		events, e := validReplayEvents(group.Bytes())
		if e != nil {
			page.Incomplete = true
			return
		}
		page.Events = append(page.Events, events...)
	}
	for i, chunk := range chunks {
		pid, url, index, seq, part, count := chunk.PageID, chunk.PageURL, chunk.PageIndex, chunk.Sequence, chunk.PartIndex, chunk.PartCount

		if page == nil || page.ID != pid {
			finish()
			result.Pages = append(result.Pages, Page{ID: pid, Index: index, URL: url, Events: []json.RawMessage{}})
			page = &result.Pages[len(result.Pages)-1]
			lastSeq = -1
		}
		if seq != lastSeq {
			finish()
			if seq != lastSeq+1 {
				page.Incomplete = true
			}
			lastSeq = seq
			group.Reset()
			parts = 0
			expected = count
			nextPart = 0
		}
		if !chunk.Ready {
			page.Incomplete = true
			continue
		}
		raw := raws[i]
		if part != nextPart || count != expected {
			page.Incomplete = true
		}
		nextPart = part + 1
		parts++
		group.Write(raw)
	}
	finish()
	for _, p := range result.Pages {
		if p.Incomplete {
			result.Incomplete = true
		}
	}
	return result, nil
}
