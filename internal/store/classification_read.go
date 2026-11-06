package store

import (
	"context"
	"encoding/json"
	"github.com/lamooof/clickshield/internal/domain"
)

// Read history and reasons in one query, without borrowing a second connection.
func (s *Store) sessionClassifications(ctx context.Context, id string) ([]domain.Classification, error) {
	rows, err := s.Pool.Query(ctx, `SELECT c.id,c.risk_score,c.classification,c.source,c.created_at,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('code',r.code,'weight',r.weight,'details',r.details) ORDER BY r.id)
 FROM classification_reasons r WHERE r.classification_id=c.id),'[]'::jsonb)
 FROM classifications c WHERE c.session_id=$1 ORDER BY c.created_at DESC,c.id DESC`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []domain.Classification
	for rows.Next() {
		c := domain.Classification{SessionID: id}
		var raw []byte
		if err = rows.Scan(&c.ID, &c.RiskScore, &c.Classification, &c.Source, &c.CreatedAt, &raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &c.Reasons); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
