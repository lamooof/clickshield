package store

import (
	"context"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lamooof/clickshield/internal/antifraud"
	"github.com/lamooof/clickshield/internal/domain"
	"os"
	"testing"
	"time"
)

func TestSessionDetailWithOneConnection(t *testing.T) {
	st, _, b := architectureFixture(t)
	if err := antifraud.NewScorer(st).Finalize(context.Background(), b.SessionID); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(os.Getenv("CLICKSHIELD_TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	cfg.MaxConns = 1
	cfg.MinConns = 0
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	detail, err := (&Store{Pool: pool}).SessionDetail(ctx, b.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.Classifications) != 1 || len(detail.Classifications[0].Reasons) == 0 {
		t.Fatal("classification reasons missing")
	}
}

func TestIdleHeartbeatDoesNotReopenSession(t *testing.T) {
	st, p, b := architectureFixture(t)
	ctx := context.Background()
	if err := antifraud.NewScorer(st).Finalize(ctx, b.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Pool.Exec(ctx, `UPDATE sessions SET started_at=now()-interval '2 hours',last_seen_at=now()-interval '1 hour' WHERE id=$1`, b.SessionID); err != nil {
		t.Fatal(err)
	}
	b.BatchID, _ = UUID()
	b.Events = []domain.Event{{Type: "heartbeat", TS: time.Now().UnixMilli(), IdleMS: 5000}}
	if _, err := st.Ingest(ctx, p, b, domain.RemoteMeta{}); err != nil {
		t.Fatal(err)
	}
	var finished, old bool
	if err := st.Pool.QueryRow(ctx, `SELECT finished_at IS NOT NULL,last_seen_at<now()-interval '30 minutes' FROM sessions WHERE id=$1`, b.SessionID).Scan(&finished, &old); err != nil {
		t.Fatal(err)
	}
	if !finished || !old {
		t.Fatal("idle-only batch extended session")
	}
	b.BatchID, _ = UUID()
	b.Events = []domain.Event{{Type: "click", TS: time.Now().UnixMilli()}}
	if _, err := st.Ingest(ctx, p, b, domain.RemoteMeta{}); err != nil {
		t.Fatal(err)
	}
	if err := st.Pool.QueryRow(ctx, `SELECT finished_at IS NULL,last_seen_at>now()-interval '5 seconds' FROM sessions WHERE id=$1`, b.SessionID).Scan(&finished, &old); err != nil {
		t.Fatal(err)
	}
	if !finished || !old {
		t.Fatal("real activity must reopen session")
	}
}

func TestBlockingMatchesFingerprint(t *testing.T) {
	st, p, b := architectureFixture(t)
	ctx := context.Background()
	p.Mode = domain.ModeBlocking
	b.BatchID, _ = UUID()
	b.Fingerprint = "same-browser-fingerprint"
	if _, err := st.Ingest(ctx, p, b, domain.RemoteMeta{}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SaveManual(ctx, b.SessionID, domain.Bot, "reviewed", ""); err != nil {
		t.Fatal(err)
	}
	for _, fp := range []string{b.Fingerprint, "", "another-browser"} {
		next := b
		next.Fingerprint = fp
		next.SessionID, _ = UUID()
		next.VisitorID, _ = UUID()
		next.BatchID, _ = UUID()
		want := "ALLOW"
		if fp == b.Fingerprint {
			want = "BLOCK"
		}
		for retry := 0; retry < 2; retry++ {
			result, err := st.Ingest(ctx, p, next, domain.RemoteMeta{})
			if err != nil || result.Decision != want {
				t.Fatalf("fingerprint %q retry %d: %+v %v", fp, retry, result, err)
			}
		}
	}
	_, other, _ := architectureFixture(t)
	other.Mode = domain.ModeBlocking
	b.SessionID, _ = UUID()
	b.VisitorID, _ = UUID()
	b.BatchID, _ = UUID()
	result, err := st.Ingest(ctx, other, b, domain.RemoteMeta{})
	if err != nil || result.Decision != "ALLOW" {
		t.Fatalf("cross-project fingerprint block: %+v %v", result, err)
	}
}
