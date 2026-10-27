-- M05 migration proposal only. The coordinator owns the actual migration sequence.
-- Jobs exist before the first planning_state, so project_id deliberately has no
-- planning_states FK. Attach the authoritative M02 project FK after integration.
-- No credentials or raw model responses are stored. Timeout recovery and explicit
-- retries are service operations; this schema never launches or retries work.

CREATE TABLE planning_generation_jobs (
  id text PRIMARY KEY CHECK (length(id) > 0),
  project_id text NOT NULL CHECK (length(project_id) > 0),
  actor_id text NOT NULL CHECK (length(actor_id) > 0),
  membership_id text NOT NULL CHECK (length(membership_id) > 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) > 0),
  command_fingerprint text NOT NULL CHECK (length(command_fingerprint) > 0),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  attempts bigint NOT NULL CHECK (attempts BETWEEN 0 AND 9007199254740991),
  created_at timestamptz NOT NULL,
  lease_expires_at timestamptz,
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  UNIQUE (project_id, actor_id, idempotency_key),
  CHECK ((body->>'id' = id AND jsonb_typeof(body->'id') = 'string') IS TRUE),
  CHECK ((body->>'projectId' = project_id AND jsonb_typeof(body->'projectId') = 'string') IS TRUE),
  CHECK ((body->>'actorId' = actor_id AND jsonb_typeof(body->'actorId') = 'string') IS TRUE),
  CHECK ((body->>'membershipId' = membership_id AND jsonb_typeof(body->'membershipId') = 'string') IS TRUE),
  CHECK ((body->>'idempotencyKey' = idempotency_key AND jsonb_typeof(body->'idempotencyKey') = 'string') IS TRUE),
  CHECK ((body->>'commandFingerprint' = command_fingerprint AND jsonb_typeof(body->'commandFingerprint') = 'string') IS TRUE),
  CHECK ((body->>'status' = status AND jsonb_typeof(body->'status') = 'string') IS TRUE),
  CHECK ((jsonb_typeof(body->'revision') = 'number' AND (body->>'revision')::bigint = revision) IS TRUE),
  CHECK ((jsonb_typeof(body->'attempts') = 'number' AND (body->>'attempts')::bigint = attempts) IS TRUE),
  CHECK ((jsonb_typeof(body->'createdAt') = 'string' AND (body->>'createdAt')::timestamptz = created_at) IS TRUE),
  CHECK ((jsonb_typeof(body->'leaseExpiresAt') IN ('string', 'null')
    AND (body->>'leaseExpiresAt')::timestamptz IS NOT DISTINCT FROM lease_expires_at) IS TRUE),
  CHECK ((status = 'running') = (lease_expires_at IS NOT NULL)),
  CHECK ((status IN ('queued', 'running')) = (jsonb_typeof(body->'finishedAt') = 'null')),
  CHECK ((jsonb_typeof(body->'finishedAt') IN ('string', 'null')) IS TRUE),
  CHECK ((jsonb_typeof(body->'startedAt') IN ('string', 'null')) IS TRUE),
  CHECK (status <> 'running' OR ((attempts > 0 AND jsonb_typeof(body->'startedAt') = 'string') IS TRUE)),
  CHECK ((jsonb_typeof(body->'resultPlanId') IN ('string', 'null')) IS TRUE),
  CHECK ((status = 'succeeded') = (jsonb_typeof(body->'resultPlanId') = 'string')),
  CHECK ((jsonb_typeof(body->'errorCode') IN ('string', 'null')) IS TRUE),
  CHECK (status <> 'failed' OR ((jsonb_typeof(body->'errorCode') = 'string' AND length(body->>'errorCode') > 0) IS TRUE)),
  CHECK ((jsonb_typeof(body->'snapshot') = 'object' AND body->'snapshot'->'input'->>'projectId' = project_id) IS TRUE),
  CHECK ((jsonb_typeof(body->'snapshot'->'tasks') = 'array') IS TRUE),
  CHECK ((jsonb_typeof(body->'snapshot'->'resourceContentRefs') = 'array') IS TRUE),
  CHECK ((jsonb_typeof(body->'snapshot'->'buffers') = 'array') IS TRUE),
  CHECK ((jsonb_typeof(body->'snapshot'->'tasksRevision') = 'number'
    AND (body->'snapshot'->>'tasksRevision')::bigint BETWEEN 0 AND 9007199254740991) IS TRUE)
);

CREATE INDEX planning_generation_project_history ON planning_generation_jobs(project_id, created_at DESC, id DESC);
CREATE INDEX planning_generation_queued ON planning_generation_jobs(created_at, id) WHERE status = 'queued';
CREATE INDEX planning_generation_running ON planning_generation_jobs(lease_expires_at, created_at, id) WHERE status = 'running';

-- Preserve jobs for audit, cancellation and explicit retry. Apply a retention policy
-- only after the coordinator establishes privacy and operational requirements.
