package store

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"github.com/lamooof/clickshield/internal/antifraud"
)

const batchRecords = `SELECT * FROM jsonb_to_recordset($4::jsonb) AS e(index int,at timestamptz,page_index int,page_url text,event jsonb)`

func writeBatchEvents(ctx context.Context, tx pgx.Tx, b antifraud.PreparedBatch) (int, bool, error) {
	raw, err := json.Marshal(b.Events)
	if err != nil {
		return 0, false, err
	}
	if b.Events == nil {
		raw = []byte("[]")
	}
	args := []any{b.Project.ID, b.Batch.SessionID, b.Batch.BatchID, raw}
	batch := &pgx.Batch{}
	batch.Queue(`WITH params AS (SELECT $1::uuid,$2::uuid,$3::uuid,$4::jsonb) INSERT INTO raw_events(project_id,session_id,batch_id,event_index,event_time,event_type,payload)
 SELECT $1,$2,$3,e.index,e.at,e.event->>'type',e.event FROM (`+batchRecords+`) e ON CONFLICT DO NOTHING`, args...)
	batch.Queue(`WITH params AS (SELECT $1::uuid,$2::uuid,$3::uuid,$4::jsonb) INSERT INTO session_pages(session_id,page_index,page_url,viewed_at)
 SELECT $2,e.page_index,e.page_url,e.at FROM (`+batchRecords+`) e WHERE e.event->>'type'='pageview' ON CONFLICT DO NOTHING`, args...)
	batch.Queue(`WITH params AS (SELECT $1::uuid,$2::uuid,$3::uuid,$4::jsonb) INSERT INTO business_events(project_id,session_id,batch_id,event_index,event_time,page_url,name,properties)
 SELECT $1,$2,$3,e.index,e.at,e.page_url,e.event->>'name',COALESCE(NULLIF(e.event->'properties','null'::jsonb),'{}'::jsonb)
 FROM (`+batchRecords+`) e WHERE e.event->>'type'='business' ON CONFLICT DO NOTHING`, args...)
	batch.Queue(`WITH params AS (SELECT $1::uuid,$2::uuid,$3::uuid,$4::jsonb) INSERT INTO heatmap_events(session_id,batch_id,event_index,event_time,page_url,event_type,viewport_width,viewport_height,document_height,x,y,depth)
 SELECT $2,$3,e.index,e.at,e.page_url,e.event->>'type',trunc((e.event->>'vw')::numeric)::int,trunc((e.event->>'vh')::numeric)::int,
 COALESCE((e.event->>'document_height')::double precision,0),COALESCE((e.event->>'x')::double precision,0),COALESCE((e.event->>'y')::double precision,0)+COALESCE((e.event->>'scroll_y')::double precision,0),COALESCE((e.event->>'depth')::double precision,0)
 FROM (`+batchRecords+`) e WHERE e.event->>'type' IN ('click','scroll') AND (e.event->>'vw')::numeric>0 AND (e.event->>'vh')::numeric>0 ON CONFLICT DO NOTHING`, args...)
	batch.Queue(visitorBlockedSQL, b.Project.ID, b.Batch.VisitorID, b.Batch.Fingerprint, b.BlockedClasses)
	results := tx.SendBatch(ctx, batch)
	defer results.Close()
	tag, err := results.Exec()
	if err != nil {
		return 0, false, err
	}
	for i := 0; i < 3; i++ {
		if _, err = results.Exec(); err != nil {
			return 0, false, err
		}
	}
	var blocked bool
	if err = results.QueryRow().Scan(&blocked); err != nil {
		return 0, false, err
	}
	return int(tag.RowsAffected()), blocked, results.Close()
}
