-- Suggestion only. The coordinator adds a new actual migration; never rewrite 001.
-- Existing queued lookup is supported by m03_run_queue_idx (status, queuedAt).
BEGIN;
CREATE INDEX IF NOT EXISTS m03_run_running_recovery_idx
  ON m03_analysis_runs ((body->>'startedAt'), id)
  WHERE body->>'status' = 'running';
COMMIT;
-- Rollback: DROP INDEX IF EXISTS m03_run_running_recovery_idx;
-- Optional providerRequestId and actual model metadata live in existing JSONB;
-- no new job table or lifecycle state is introduced.
