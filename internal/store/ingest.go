package store

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/lamooof/clickshield/internal/antifraud"
	"github.com/lamooof/clickshield/internal/domain"
	"github.com/lamooof/clickshield/internal/feature"
	"net"
)

type IngestResult = antifraud.IngestResult

func (s *Store) Ingest(ctx context.Context, p domain.Project, b domain.EventBatch, r domain.RemoteMeta) (IngestResult, error) {
	return antifraud.NewIngestor(s).Ingest(ctx, p, b, r)
}

func (s *Store) WriteBatch(ctx context.Context, prepared antifraud.PreparedBatch) (int, bool, error) {
	if err := s.EnsureRawPartitions(ctx); err != nil {
		return 0, false, err
	}
	project, b, remote := prepared.Project, prepared.Batch, prepared.Remote
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return 0, false, e
	}
	defer tx.Rollback(ctx)
	// Serialize initial creation and retries for this session, including ownership.
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, b.SessionID); e != nil {
		return 0, false, e
	}
	var receiptProject, receiptVisitor string
	e = tx.QueryRow(ctx, `INSERT INTO ingest_batches(session_id,batch_id,project_id,visitor_key) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING project_id::text,visitor_key`, b.SessionID, b.BatchID, project.ID, b.VisitorID).Scan(&receiptProject, &receiptVisitor)
	if IsNotFound(e) {
		e = tx.QueryRow(ctx, `SELECT project_id::text,visitor_key FROM ingest_batches WHERE session_id=$1 AND batch_id=$2`, b.SessionID, b.BatchID).Scan(&receiptProject, &receiptVisitor)
		if e != nil {
			return 0, false, e
		}
		if receiptProject != project.ID || receiptVisitor != b.VisitorID {
			return 0, false, fmt.Errorf("batch belongs to another session owner")
		}
		blocked, e := visitorBlocked(ctx, tx, project.ID, b.VisitorID, b.Fingerprint, prepared.BlockedClasses)
		if e != nil {
			return 0, false, e
		}
		return 0, blocked, tx.Commit(ctx)
	}
	if e != nil {
		return 0, false, e
	}
	visitorID, e := UUID()
	if e != nil {
		return 0, false, e
	}
	e = tx.QueryRow(ctx, `INSERT INTO visitors(id,project_id,visitor_key,fingerprint) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,visitor_key) DO UPDATE SET fingerprint=CASE WHEN EXCLUDED.fingerprint<>'' THEN EXCLUDED.fingerprint ELSE visitors.fingerprint END,last_seen_at=now() RETURNING id::text`, visitorID, project.ID, b.VisitorID, b.Fingerprint).Scan(&visitorID)
	if e != nil {
		return 0, false, e
	}
	device, e := json.Marshal(b.Device)
	if e != nil {
		return 0, false, e
	}
	automation, e := json.Marshal(b.Automation)
	if e != nil {
		return 0, false, e
	}
	var ip any
	if remote.IP != nil {
		ip = remote.IP.String()
	}
	page := b.PageIndex
	var sessionID string
	state, err := loadFeatureState(ctx, tx, b.SessionID)
	if err != nil {
		return 0, false, err
	}
	events := make([]domain.Event, 0, len(prepared.Events))
	for _, event := range prepared.Events {
		events = append(events, event.Event)
	}
	state.Add(events)
	stateRaw, err := json.Marshal(state)
	if err != nil {
		return 0, false, err
	}
	e = tx.QueryRow(ctx, `INSERT INTO sessions(id,project_id,visitor_id,visitor_key,fingerprint,yandex_client_id,google_client_id,yclid,gclid,utm_source,utm_medium,utm_campaign,utm_term,utm_content,referrer,landing_url,last_page_url,ip,asn,as_org,country,user_agent,device_type,device,automation,page_count,bot_name,bot_category,rb_clickid,browser,os,region,city,traffic_source,traffic_channel,referrer_host,attribution_basis,finished_at,finish_requested_at,data_revision,feature_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb,$25::jsonb,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,NULL,CASE WHEN $38 THEN now() END,1,$39::jsonb)
	ON CONFLICT(id) DO UPDATE SET visitor_id=EXCLUDED.visitor_id,visitor_key=EXCLUDED.visitor_key,fingerprint=CASE WHEN EXCLUDED.fingerprint<>'' THEN EXCLUDED.fingerprint ELSE sessions.fingerprint END,yandex_client_id=CASE WHEN EXCLUDED.yandex_client_id<>'' THEN EXCLUDED.yandex_client_id ELSE sessions.yandex_client_id END,google_client_id=CASE WHEN EXCLUDED.google_client_id<>'' THEN EXCLUDED.google_client_id ELSE sessions.google_client_id END,yclid=CASE WHEN EXCLUDED.yclid<>'' THEN EXCLUDED.yclid ELSE sessions.yclid END,rb_clickid=CASE WHEN EXCLUDED.rb_clickid<>'' THEN EXCLUDED.rb_clickid ELSE sessions.rb_clickid END,gclid=CASE WHEN EXCLUDED.gclid<>'' THEN EXCLUDED.gclid ELSE sessions.gclid END,utm_source=sessions.utm_source,utm_medium=sessions.utm_medium,utm_campaign=sessions.utm_campaign,utm_term=sessions.utm_term,utm_content=sessions.utm_content,referrer=sessions.referrer,landing_url=CASE WHEN sessions.landing_url='' THEN EXCLUDED.landing_url ELSE sessions.landing_url END,last_page_url=EXCLUDED.last_page_url,ip=COALESCE(EXCLUDED.ip,sessions.ip),asn=CASE WHEN EXCLUDED.asn<>'' THEN EXCLUDED.asn ELSE sessions.asn END,as_org=CASE WHEN EXCLUDED.as_org<>'' THEN EXCLUDED.as_org ELSE sessions.as_org END,country=CASE WHEN EXCLUDED.country<>'' THEN EXCLUDED.country ELSE sessions.country END,user_agent=CASE WHEN EXCLUDED.user_agent<>'' THEN EXCLUDED.user_agent ELSE sessions.user_agent END,bot_name=CASE WHEN EXCLUDED.user_agent<>'' THEN EXCLUDED.bot_name ELSE sessions.bot_name END,bot_category=CASE WHEN EXCLUDED.user_agent<>'' THEN EXCLUDED.bot_category ELSE sessions.bot_category END,device_type=EXCLUDED.device_type,device=sessions.device||EXCLUDED.device,automation=sessions.automation||EXCLUDED.automation,page_count=GREATEST(sessions.page_count,EXCLUDED.page_count),browser=EXCLUDED.browser,os=EXCLUDED.os,region=CASE WHEN EXCLUDED.region<>'' THEN EXCLUDED.region ELSE sessions.region END,city=CASE WHEN EXCLUDED.city<>'' THEN EXCLUDED.city ELSE sessions.city END,traffic_source=CASE WHEN sessions.traffic_channel='' THEN EXCLUDED.traffic_source ELSE sessions.traffic_source END,traffic_channel=CASE WHEN sessions.traffic_channel='' THEN EXCLUDED.traffic_channel ELSE sessions.traffic_channel END,referrer_host=CASE WHEN sessions.traffic_channel='' THEN EXCLUDED.referrer_host ELSE sessions.referrer_host END,attribution_basis=CASE WHEN sessions.traffic_channel='' THEN EXCLUDED.attribution_basis ELSE sessions.attribution_basis END,finished_at=CASE WHEN $40 THEN NULL ELSE sessions.finished_at END,finish_requested_at=CASE WHEN $38 THEN now() ELSE sessions.finish_requested_at END,data_revision=sessions.data_revision+1,feature_state=EXCLUDED.feature_state,last_seen_at=CASE WHEN $40 THEN now() ELSE sessions.last_seen_at END,updated_at=now() WHERE sessions.project_id=EXCLUDED.project_id AND sessions.visitor_key=EXCLUDED.visitor_key RETURNING id::text`, b.SessionID, project.ID, visitorID, b.VisitorID, b.Fingerprint, b.YandexClientID, b.GoogleClientID, b.YCLID, b.GCLID, b.UTM.Source, b.UTM.Medium, b.UTM.Campaign, b.UTM.Term, b.UTM.Content, b.Referrer, b.LandingURL, b.PageURL, ip, remote.ASN, remote.ASOrg, remote.Country, remote.UserAgent, b.Device.Type, device, automation, page, prepared.BotName, prepared.BotCategory, b.RBClickID, prepared.Browser, prepared.OS, remote.Region, remote.City, prepared.Attribution.Source, prepared.Attribution.Channel, prepared.Attribution.ReferrerHost, prepared.Attribution.Basis, b.Finish, stateRaw, prepared.Active).Scan(&sessionID)
	if e != nil {
		return 0, false, fmt.Errorf("session: %w", e)
	}
	pages := map[int]string{}
	rows, e := tx.Query(ctx, `SELECT page_index,page_url FROM session_pages WHERE session_id=$1`, b.SessionID)
	if e != nil {
		return 0, false, e
	}
	for rows.Next() {
		var index int
		var page string
		if e = rows.Scan(&index, &page); e != nil {
			rows.Close()
			return 0, false, e
		}
		pages[index] = page
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return 0, false, e
	}
	antifraud.ResolvePages(&prepared, pages)
	inserted, blocked, e := writeBatchEvents(ctx, tx, prepared)
	if e != nil {
		return 0, false, e
	}
	return inserted, blocked, tx.Commit(ctx)
}

func visitorBlocked(ctx context.Context, tx pgx.Tx, project, visitor, fingerprint string, classes []string) (bool, error) {
	if len(classes) == 0 {
		return false, nil
	}
	var blocked bool
	err := tx.QueryRow(ctx, visitorBlockedSQL, project, visitor, fingerprint, classes).Scan(&blocked)
	return blocked, err
}

func (s *Store) RequestFinish(ctx context.Context, projectID string, r domain.FinishRequest) error {
	tag, e := s.Pool.Exec(ctx, `UPDATE sessions SET finish_requested_at=now(),data_revision=data_revision+1,updated_at=now() WHERE id=$1 AND project_id=$2 AND visitor_key=$3`, r.SessionID, projectID, r.VisitorID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

func IPFromRequest(remoteAddr string) net.IP {
	host, _, e := net.SplitHostPort(remoteAddr)
	if e != nil {
		host = remoteAddr
	}
	return net.ParseIP(host)
}

func loadFeatureState(ctx context.Context, tx pgx.Tx, id string) (feature.State, error) {
	var state feature.State
	var raw []byte
	err := tx.QueryRow(ctx, `SELECT feature_state FROM sessions WHERE id=$1`, id).Scan(&raw)
	if IsNotFound(err) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	if raw != nil {
		return state, json.Unmarshal(raw, &state)
	}
	rows, err := tx.Query(ctx, `SELECT payload FROM raw_events WHERE session_id=$1 ORDER BY event_time,id`, id)
	if err != nil {
		return state, err
	}
	defer rows.Close()
	for rows.Next() {
		var event domain.Event
		if err = rows.Scan(&raw); err != nil {
			return state, err
		}
		if err = json.Unmarshal(raw, &event); err != nil {
			return state, err
		}
		state.Add([]domain.Event{event})
	}
	return state, rows.Err()
}
