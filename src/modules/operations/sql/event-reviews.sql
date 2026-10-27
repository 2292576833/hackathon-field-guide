-- M08 proposal only. Coordinator combines/applies migrations; M03 supplies same-transaction content ports.
CREATE TABLE IF NOT EXISTS operations_event_reviews (
  id text PRIMARY KEY,
  event_id text NOT NULL,
  candidate_id text NOT NULL UNIQUE,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('pending','changes_requested','approved','rejected','published')),
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  CHECK ((jsonb_typeof(payload) = 'object') IS TRUE),
  CHECK ((payload->>'id' = id AND payload->>'eventId' = event_id AND payload->>'candidateId' = candidate_id) IS TRUE),
  CHECK (((payload->>'revision')::integer = revision) IS TRUE),
  CHECK ((payload->>'status' = status) IS TRUE)
);
CREATE INDEX IF NOT EXISTS operations_event_reviews_queue ON operations_event_reviews(status,updated_at DESC,id);
CREATE TABLE IF NOT EXISTS operations_event_review_audit (
  id text PRIMARY KEY,
  event_id text NOT NULL,
  review_id text REFERENCES operations_event_reviews(id),
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK ((jsonb_typeof(payload) = 'object') IS TRUE)
);
CREATE INDEX IF NOT EXISTS operations_event_review_audit_event ON operations_event_review_audit(event_id,occurred_at);
-- Application audit writes are append-only; deploy role should lack UPDATE/DELETE on audit tables.
-- Rollback on a disposable empty installation: drop audit then reviews. For saved review data,
-- back up tables and retain M03 published rule snapshots; never cascade-drop Event/Project content.
