-- Additive proposal only. Root assigns the production migration number.
-- Answers/results are private M04 data, never copied to M02 intentions or team outbox.
CREATE TABLE IF NOT EXISTS assessments_role_help_jobs (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  user_id text NOT NULL,
  membership_id text NOT NULL,
  idempotency_key text NOT NULL,
  input_fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  revision integer NOT NULL CHECK (revision >= 1),
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  failure_code text,
  data jsonb NOT NULL,
  UNIQUE(project_id,user_id,idempotency_key),
  CHECK (data->>'id'=id AND data->>'projectId'=project_id AND data->>'userId'=user_id AND data->>'membershipId'=membership_id),
  CHECK (data->>'status'=status AND (data->>'revision')::integer=revision),
  CHECK (status<>'running' OR started_at IS NOT NULL),
  CHECK (status<>'succeeded' OR finished_at IS NOT NULL AND failure_code IS NULL AND jsonb_typeof(data->'result')='object'),
  CHECK (status<>'failed' OR finished_at IS NOT NULL AND failure_code IS NOT NULL AND data->'result'='null'::jsonb)
);
CREATE INDEX IF NOT EXISTS assessments_role_help_jobs_queue ON assessments_role_help_jobs(status,created_at,id);
CREATE INDEX IF NOT EXISTS assessments_role_help_jobs_owner ON assessments_role_help_jobs(project_id,user_id,membership_id,created_at DESC,id DESC);
CREATE FUNCTION assessments_guard_role_help_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.input_fingerprint IS DISTINCT FROM OLD.input_fingerprint
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (NEW.data - ARRAY['status','revision','startedAt','finishedAt','result','failureCode'])
      IS DISTINCT FROM (OLD.data - ARRAY['status','revision','startedAt','finishedAt','result','failureCode'])
    OR NEW.revision<>OLD.revision+1
    OR NOT ((OLD.status='queued' AND NEW.status='running') OR (OLD.status='running' AND NEW.status IN ('succeeded','failed'))) THEN
    RAISE EXCEPTION 'M04 role help input and terminal facts are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assessments_role_help_job_guard BEFORE UPDATE ON assessments_role_help_jobs
  FOR EACH ROW EXECUTE FUNCTION assessments_guard_role_help_job();
