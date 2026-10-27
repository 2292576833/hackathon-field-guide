-- Additive M01 proposal. Coordinator assigns a new root migration number and runs it.
-- Do not rewrite the already-applied auth initial migration.
ALTER TABLE auth_sessions ADD COLUMN last_seen_at timestamptz;
UPDATE auth_sessions SET last_seen_at = created_at WHERE last_seen_at IS NULL;
ALTER TABLE auth_sessions ALTER COLUMN last_seen_at SET NOT NULL;
-- Default keeps old server instances/direct controlled inserts compatible during rollout.
ALTER TABLE auth_sessions ALTER COLUMN last_seen_at SET DEFAULT now();
-- No UA, raw IP, client header, device fingerprint, or credential is stored.
-- Rollback: after rolling back application usage, drop the column.
