-- INCREMENTAL MIGRATION SUGGESTION ONLY. Root selects the sequence and applies.
-- M10 publication/candidate SQL must exist first. No second content or compatibility store.
CREATE TABLE IF NOT EXISTS operations_skill_reviews (
  review_id text PRIMARY KEY,
  target_kind text NOT NULL CHECK (target_kind IN ('skill','bundle')),
  target_id text NOT NULL,
  version_id text NOT NULL,
  candidate_revision integer NOT NULL CHECK (candidate_revision > 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('pending','changes_requested','approved','rejected','published')),
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (target_kind,target_id,version_id,candidate_revision),
  CHECK ((jsonb_typeof(payload) = 'object') IS TRUE),
  CHECK ((payload->>'reviewId' = review_id AND payload->>'kind' = target_kind AND payload->>'id' = target_id AND payload->>'versionId' = version_id) IS TRUE),
  CHECK (((payload->>'candidateRevision')::integer = candidate_revision AND (payload->>'revision')::integer = revision) IS TRUE),
  CHECK ((payload->>'contentHash' = content_hash AND payload->>'manifestHash' = manifest_hash AND payload->>'status' = status) IS TRUE)
);
CREATE INDEX IF NOT EXISTS operations_skill_reviews_queue ON operations_skill_reviews (status,updated_at DESC,review_id DESC);
CREATE TABLE IF NOT EXISTS operations_skill_withdrawal_keys (
  actor_id text NOT NULL,
  operation_id text NOT NULL,
  PRIMARY KEY (actor_id,operation_id)
);
CREATE TABLE IF NOT EXISTS operations_skill_review_audit (
  audit_id text PRIMARY KEY,
  target_kind text NOT NULL CHECK (target_kind IN ('skill','bundle')),
  target_id text NOT NULL,
  version_id text NOT NULL,
  review_id text REFERENCES operations_skill_reviews(review_id),
  actor_id text NOT NULL,
  operation_id text,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  CHECK ((jsonb_typeof(payload) = 'object') IS TRUE),
  CHECK ((payload->>'auditId' = audit_id AND payload->>'kind' = target_kind AND payload->>'id' = target_id AND payload->>'versionId' = version_id AND payload->>'actorId' = actor_id) IS TRUE),
  CHECK ((payload->>'operationId' IS NOT DISTINCT FROM operation_id) IS TRUE)
);
CREATE UNIQUE INDEX IF NOT EXISTS operations_skill_review_withdrawal_idempotency ON operations_skill_review_audit (actor_id,operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS operations_skill_review_history ON operations_skill_review_audit (target_kind,target_id,version_id,occurred_at DESC);
-- Website role: SELECT/INSERT audit, no UPDATE/DELETE audit; no worker privileges.
-- Lock order: actor withdrawal key (withdraw only), M10 candidate/bundle/sorted
-- required skills, M08 review. M10 publication and M08 review/audit MUST use the
-- same SqlExecutor/DatabasePort transaction; no external I/O or independent commits.
