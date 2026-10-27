-- M01 additive proposal only. Root owns numbering, backups and actual execution.
-- JSONB records are private storage: never return code hashes or export bodies in status APIs.
CREATE TABLE auth_data_exports (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  CHECK (body ?& ARRAY['id', 'userId', 'status', 'createdAt', 'updatedAt', 'expiresAt', 'revision', 'attempts', 'errorCode', 'byteLength', 'document']),
  CHECK (body->>'id' IS NOT NULL AND body->>'userId' IS NOT NULL AND body->>'id' = id AND body->>'userId' = user_id),
  CHECK (jsonb_typeof(body->'revision') = 'number' AND jsonb_typeof(body->'attempts') = 'number'
    AND (body->>'revision')::integer > 0 AND (body->>'attempts')::integer >= 0),
  CHECK (body->>'status' IN ('queued', 'ready', 'failed', 'expired')),
  CHECK ((body->>'createdAt')::timestamptz = created_at AND (body->>'expiresAt')::timestamptz = expires_at)
);
CREATE INDEX auth_data_exports_owner ON auth_data_exports (user_id, created_at DESC, id);
CREATE INDEX auth_data_exports_expiry ON auth_data_exports (expires_at, id) WHERE body->>'status' <> 'expired';

CREATE TABLE auth_deletion_requests (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  created_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'blocked', 'processing', 'cancelled')),
  CHECK (body ?& ARRAY['id', 'userId', 'status', 'createdAt', 'updatedAt', 'revision', 'impact']),
  CHECK (body->>'id' IS NOT NULL AND body->>'userId' IS NOT NULL AND body->>'id' = id AND body->>'userId' = user_id),
  CHECK (jsonb_typeof(body->'revision') = 'number' AND (body->>'revision')::integer > 0 AND body->>'status' = status),
  CHECK ((body->>'createdAt')::timestamptz = created_at)
);
CREATE INDEX auth_deletion_requests_owner ON auth_deletion_requests (user_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX auth_deletion_requests_one_active ON auth_deletion_requests (user_id) WHERE status <> 'cancelled';

CREATE TABLE auth_email_change_challenges (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  old_email text NOT NULL CHECK (old_email = lower(old_email) AND length(old_email) <= 254),
  new_email text NOT NULL CHECK (new_email = lower(new_email) AND length(new_email) <= 254 AND new_email <> old_email),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  consumed_at timestamptz,
  revoked_at timestamptz,
  CHECK (body ?& ARRAY['id', 'userId', 'oldEmail', 'newEmail', 'expectedRevision', 'currentCodeHash', 'newCodeHash', 'createdAt', 'expiresAt', 'delivery', 'failedAttempts', 'consumedAt', 'revokedAt']),
  CHECK (body->>'id' IS NOT NULL AND body->>'userId' IS NOT NULL AND body->>'id' = id AND body->>'userId' = user_id),
  CHECK (body->>'oldEmail' = old_email AND body->>'newEmail' = new_email),
  CHECK (jsonb_typeof(body->'expectedRevision') = 'number' AND jsonb_typeof(body->'failedAttempts') = 'number'
    AND (body->>'expectedRevision')::integer > 0 AND (body->>'failedAttempts')::integer >= 0),
  CHECK (body->>'currentCodeHash' ~ '^[0-9a-f]{64}$' AND body->>'newCodeHash' ~ '^[0-9a-f]{64}$'),
  CHECK (body->>'delivery' IN ('pending', 'ready', 'unknown')),
  CHECK ((body->>'createdAt')::timestamptz = created_at AND (body->>'expiresAt')::timestamptz = expires_at),
  CHECK ((body->>'consumedAt')::timestamptz IS NOT DISTINCT FROM consumed_at),
  CHECK ((body->>'revokedAt')::timestamptz IS NOT DISTINCT FROM revoked_at)
);
CREATE INDEX auth_email_change_challenges_owner ON auth_email_change_challenges (user_id, created_at DESC);
CREATE INDEX auth_email_change_challenges_expiry ON auth_email_change_challenges (expires_at);

-- No automatic deletion, repository operation or credential storage is introduced.
-- Root calls PostgresAccountStore.clearExpiredExportDocuments on a retention worker
-- to clear expired private bodies in bounded batches while retaining request metadata.
-- Cleanup uses export row locks with SKIP LOCKED and does not lock shared auth identities.
