-- M04 proposal only: root integrates this as a new numbered migration.
-- The runtime scanner reads only job metadata and filters JSONB startedAt; it does
-- not join private answer aggregates or hold row locks during model execution.
BEGIN;
CREATE INDEX IF NOT EXISTS assessments_scoring_jobs_running_recovery
  ON assessments_scoring_jobs (created_at, id) WHERE status = 'running';
COMMENT ON INDEX assessments_scoring_jobs_running_recovery IS
  'Private running job metadata scan index; actual lease expiry uses data.startedAt and the service rechecks expiry before terminal recovery.';
COMMIT;
