package httpapi

import (
	"compress/gzip"
	"encoding/json"
	"errors"
	"github.com/lamooof/clickshield/internal/replay"
	"github.com/lamooof/clickshield/internal/store"
	"net/http"
	"strings"
	"time"
)

func validateReplayPart(p *replay.Part) string {
	if !store.ValidUUID(p.SessionID) || !store.ValidUUID(p.VisitorID) || !store.ValidUUID(p.PageID) {
		return "valid session, visitor and page IDs required"
	}
	if p.Sequence < 0 || p.Sequence > 5000 || p.PartCount < 1 || p.PartCount > 64 || p.PartIndex < 0 || p.PartIndex >= p.PartCount || p.PageIndex < 1 || p.PageIndex > 1000 {
		return "invalid fragment indexes"
	}
	if len(p.Data) == 0 || len(p.Data) > replay.MaxPart {
		return "fragment must be 1–131072 bytes"
	}
	now := time.Now().UnixMilli()
	if p.StartedAt <= 0 || p.StartedAt > now+600000 || p.StartedAt < now-7*24*3600000 || p.EndedAt < p.StartedAt || p.EndedAt > now+600000 {
		return "invalid timestamps"
	}
	p.PageURL = sanitizeURL(p.PageURL)
	if p.PageURL == "" {
		return "page URL required"
	}
	return ""
}
func (s *Server) replayIngest(w http.ResponseWriter, r *http.Request) {
	p, ok := s.publicProject(w, r)
	if !ok {
		return
	}
	if !setCORS(w, r, p.AllowedOrigins) {
		writeError(w, 403, "origin is not allowed")
		return
	}
	if !p.ReplayEnabled {
		writeError(w, 403, "recording is disabled")
		return
	}
	var req replay.Part
	if e := readJSON(w, r, &req, 200<<10); e != nil {
		writeError(w, 400, "invalid replay payload")
		return
	}
	if msg := validateReplayPart(&req); msg != "" {
		writeError(w, 422, msg)
		return
	}
	if !s.replayLimiter.AllowN(p.ID+"|"+limitKey(IPFromHTTP(r, s.cfg.TrustProxyHeaders)), len(req.Data)) {
		writeError(w, 429, "replay rate limit exceeded")
		return
	}
	e := s.replay.SaveReplayPart(r.Context(), p.ID, req)
	switch {
	case errors.Is(e, replay.ErrNotFound):
		writeError(w, 409, "session unavailable or recording disabled")
	case errors.Is(e, replay.ErrQuota):
		writeError(w, 413, e.Error())
	case errors.Is(e, replay.ErrConflict):
		writeError(w, 409, e.Error())
	case e != nil:
		s.log.Error("replay ingest", "error", e)
		writeError(w, 500, "could not store replay")
	default:
		writeJSON(w, 202, map[string]any{"accepted": true})
	}
}
func (s *Server) replayData(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !store.ValidUUID(id) {
		writeError(w, 400, "invalid session id")
		return
	}
	data, e := s.replay.Replay(r.Context(), id)
	if e != nil {
		s.log.Error("replay load", "error", e)
		writeError(w, 500, "could not load replay")
		return
	}
	writeMaybeGzipJSON(w, r, data)
}

// writeMaybeGzipJSON compresses large replay responses; rrweb JSON shrinks 5–10×.
func writeMaybeGzipJSON(w http.ResponseWriter, r *http.Request, v any) {
	w.Header().Add("Vary", "Accept-Encoding")
	if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		writeJSON(w, 200, v)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Encoding", "gzip")
	w.WriteHeader(200)
	z, _ := gzip.NewWriterLevel(w, gzip.BestSpeed)
	_ = json.NewEncoder(z).Encode(v)
	_ = z.Close()
}
func (s *Server) deleteReplay(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !store.ValidUUID(id) {
		writeError(w, 400, "invalid session id")
		return
	}
	if e := s.replay.Delete(r.Context(), id); e != nil {
		writeError(w, 500, "could not delete replay")
		return
	}
	a, _ := adminFrom(r.Context())
	s.store.Audit(r.Context(), a.UserID, "DELETE_REPLAY", "session", id, nil)
	writeJSON(w, 200, map[string]any{"ok": true})
}
