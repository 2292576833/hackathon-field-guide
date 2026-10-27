
CREATE TABLE ai_execution_jobs (
 id text PRIMARY KEY, kind text NOT NULL, module_job_id text NOT NULL, source_revision integer NOT NULL CHECK(source_revision>0),
 project_id text NOT NULL, actor_id text NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled','unknown')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), lease_owner text, lease_token text, lease_until timestamptz,
 error_code text CHECK(error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 external_state text NOT NULL DEFAULT 'not_sent' CHECK(external_state IN ('not_sent','rejected','response_received','unknown')),
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 UNIQUE(kind,module_job_id,source_revision),
 CHECK((status='running' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR
       (status<>'running' AND lease_owner IS NULL AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX ai_execution_queue ON ai_execution_jobs(status,created_at,id);
CREATE TABLE ai_budget_buckets (
 project_id text NOT NULL, period date NOT NULL,
 calls integer NOT NULL DEFAULT 0 CHECK(calls>=0), reserved_micro_usd bigint NOT NULL DEFAULT 0 CHECK(reserved_micro_usd>=0),
 charged_micro_usd bigint NOT NULL DEFAULT 0 CHECK(charged_micro_usd>=0), PRIMARY KEY(project_id,period)
);
CREATE TABLE ai_usage_attempts (
 id text PRIMARY KEY, execution_id text NOT NULL REFERENCES ai_execution_jobs(id), project_id text NOT NULL, actor_id text NOT NULL,
 period date NOT NULL, model_version text NOT NULL, prompt_version text NOT NULL,
 status text NOT NULL CHECK(status IN ('reserved','settled')),
 cost_configured boolean NOT NULL, input_rate_micro_usd_per_million bigint, output_rate_micro_usd_per_million bigint,
 reserved_micro_usd bigint, charged_micro_usd bigint, input_tokens bigint, output_tokens bigint,
 usage_verified boolean NOT NULL DEFAULT false,
 external_state text NOT NULL CHECK(external_state IN ('not_sent','rejected','response_received','unknown')),
 request_id text, error_code text CHECK(error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 created_at timestamptz NOT NULL, settled_at timestamptz,
 CHECK(input_tokens IS NULL OR input_tokens>=0), CHECK(output_tokens IS NULL OR output_tokens>=0),
 CHECK((cost_configured AND input_rate_micro_usd_per_million>=0 AND output_rate_micro_usd_per_million>=0 AND reserved_micro_usd>=0) OR
       (NOT cost_configured AND input_rate_micro_usd_per_million IS NULL AND output_rate_micro_usd_per_million IS NULL AND reserved_micro_usd IS NULL AND charged_micro_usd IS NULL)),
 CHECK((status='reserved' AND settled_at IS NULL) OR (status='settled' AND settled_at IS NOT NULL))
);
CREATE INDEX ai_usage_execution ON ai_usage_attempts(execution_id,created_at,id);
CREATE TABLE ai_generation_admissions (
 job_id text PRIMARY KEY, project_id text NOT NULL, actor_id text NOT NULL, admitted_at timestamptz NOT NULL
);
