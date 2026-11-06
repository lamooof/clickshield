package store

// Empty fingerprints never match another visitor. Both identities are project-local.
const visitorBlockedSQL = `SELECT EXISTS(SELECT 1 FROM sessions WHERE project_id=$1
 AND (visitor_key=$2 OR ($3<>'' AND fingerprint=$3))
 AND last_seen_at>now()-interval '30 days' AND current_classification=ANY($4))`
