-- M06 migration suggestion only. The coordinating session owns actual migration execution.
-- Project/user/event foreign keys should be wired to canonical tables by the coordinator.
CREATE TABLE m06_delivery_verifications (
  id text NOT NULL,
  project_id text NOT NULL,
  version integer NOT NULL CHECK (version = 1),
  repository_commit_sha text CHECK (repository_commit_sha ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  verifier_id text NOT NULL,
  verified_at timestamptz NOT NULL,
  environment_summary text NOT NULL,
  steps text[] NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('passed', 'failed', 'inconclusive')),
  blockers text[] NOT NULL,
  evidence_refs text[] NOT NULL,
  verification_source text NOT NULL CHECK (verification_source = 'user_reported'),
  PRIMARY KEY (id, version),
  CHECK (outcome <> 'passed' OR
    (length(btrim(environment_summary)) > 0 AND cardinality(steps) > 0 AND cardinality(evidence_refs) > 0 AND cardinality(blockers) = 0))
);
CREATE INDEX m06_delivery_verifications_project ON m06_delivery_verifications (project_id, verified_at DESC);

-- Heads are the only mutable submission rows. History snapshots are insert-only.
CREATE TABLE m06_submission_heads (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  UNIQUE (id, project_id)
);
CREATE TABLE m06_submission_versions (
  id text NOT NULL,
  project_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  event_id text NOT NULL,
  stage_id text NOT NULL,
  requirements_version text NOT NULL,
  platform_url text NOT NULL CHECK (platform_url ~ '^https://'),
  submitted_at timestamptz,
  verification_source text NOT NULL CHECK (verification_source = 'user_reported'),
  repository_commit_sha text CHECK (repository_commit_sha ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  status text NOT NULL CHECK (status IN ('not_submitted', 'reported', 'rejected_or_withdrawn')),
  evidence_refs text[] NOT NULL,
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (id, version),
  FOREIGN KEY (id, project_id) REFERENCES m06_submission_heads (id, project_id),
  CHECK (status <> 'reported' OR (submitted_at IS NOT NULL AND cardinality(evidence_refs) > 0)),
  CHECK (status <> 'not_submitted' OR submitted_at IS NULL)
);
CREATE INDEX m06_submission_versions_project ON m06_submission_versions (project_id, recorded_at DESC, id, version DESC);

-- Fact/audit metadata is committed with the corresponding fact/version. No shared schema dependencies.
-- Consumers can deduplicate by id. No evidence refs, upload text or credentials belong in details.
CREATE TABLE m06_delivery_fact_events (
  id text PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN ('DeliveryValidationRecorded', 'SubmissionRecorded')),
  aggregate_id text NOT NULL,
  project_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  actor_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL,
  UNIQUE (event_type, aggregate_id, version)
);
CREATE INDEX m06_delivery_fact_events_project ON m06_delivery_fact_events (project_id, occurred_at DESC);

-- Enforce history immutability even if another query accidentally tries to update/delete it.
CREATE FUNCTION m06_reject_delivery_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'M06 delivery facts are immutable; append a new fact/version';
END;
$$;
CREATE TRIGGER m06_verifications_immutable BEFORE UPDATE OR DELETE ON m06_delivery_verifications
  FOR EACH ROW EXECUTE FUNCTION m06_reject_delivery_history_mutation();
CREATE TRIGGER m06_submission_versions_immutable BEFORE UPDATE OR DELETE ON m06_submission_versions
  FOR EACH ROW EXECUTE FUNCTION m06_reject_delivery_history_mutation();
CREATE TRIGGER m06_delivery_fact_events_immutable BEFORE UPDATE OR DELETE ON m06_delivery_fact_events
  FOR EACH ROW EXECUTE FUNCTION m06_reject_delivery_history_mutation();

-- Rollback: archive/export private facts first, then remove these tables/functions in dependency order.
-- Any user-data erasure workflow needs a separately authorized migration or privileged maintenance path.
