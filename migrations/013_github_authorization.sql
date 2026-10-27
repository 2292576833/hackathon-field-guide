-- M06 proposal only: coordinator must install as a new migration, never rewrite an applied migration.
-- Tokens/verifiers are authenticated ciphertext. State and browser handles are SHA-256 hashes only.
CREATE TABLE m06_github_authorization_epochs (
  user_id text NOT NULL CHECK (octet_length(user_id) BETWEEN 1 AND 256),
  app_id bigint NOT NULL CHECK (app_id>0), authorization_epoch bigint NOT NULL DEFAULT 0 CHECK (authorization_epoch BETWEEN 0 AND 9007199254740991),
  revocation_in_progress boolean NOT NULL DEFAULT false,
  PRIMARY KEY(user_id,app_id)
);
CREATE TABLE m06_github_authorization_states (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[a-f0-9]{64}$'),
  user_id text NOT NULL CHECK (octet_length(user_id) BETWEEN 1 AND 256), app_id bigint NOT NULL CHECK (app_id>0),
  browser_hash text NOT NULL CHECK (browser_hash ~ '^[a-f0-9]{64}$'),
  encrypted_verifier jsonb NOT NULL CHECK (jsonb_typeof(encrypted_verifier)='object' AND octet_length(encrypted_verifier::text)<=90000),
  project_id text CHECK (project_id IS NULL OR octet_length(project_id) BETWEEN 1 AND 256),
  return_to text NOT NULL CHECK (octet_length(return_to) BETWEEN 1 AND 2048),
  created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL CHECK (expires_at>created_at),
  authorization_epoch bigint NOT NULL CHECK (authorization_epoch>=0),
  flow text NOT NULL CHECK (flow IN ('authorization','installation')),
  FOREIGN KEY(user_id,app_id) REFERENCES m06_github_authorization_epochs(user_id,app_id),
  CHECK (encrypted_verifier ?& ARRAY['keyId','iv','tag','data'] AND encrypted_verifier - ARRAY['keyId','iv','tag','data']='{}'::jsonb)
);
CREATE INDEX m06_github_authorization_states_expiry ON m06_github_authorization_states(expires_at);
CREATE INDEX m06_github_authorization_states_owner ON m06_github_authorization_states(user_id,app_id);
CREATE TABLE m06_github_authorization_credentials (
  user_id text NOT NULL CHECK (octet_length(user_id) BETWEEN 1 AND 256), app_id bigint NOT NULL CHECK (app_id>0),
  github_user_id bigint NOT NULL CHECK (github_user_id>0), github_login text NOT NULL CHECK (octet_length(github_login) BETWEEN 1 AND 100),
  encrypted_tokens jsonb CHECK (encrypted_tokens IS NULL OR jsonb_typeof(encrypted_tokens)='object' AND octet_length(encrypted_tokens::text)<=90000),
  access_expires_at timestamptz NOT NULL, refresh_expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('active','refreshing','revoked','reauthorize_required')),
  revision integer NOT NULL CHECK (revision>0), refresh_lease_until timestamptz, checked_at timestamptz NOT NULL,
  revocation_pending boolean NOT NULL DEFAULT false CHECK (NOT revocation_pending OR status='revoked'),
  PRIMARY KEY(user_id,app_id), FOREIGN KEY(user_id,app_id) REFERENCES m06_github_authorization_epochs(user_id,app_id),
  CHECK ((status='refreshing')=(refresh_lease_until IS NOT NULL)),
  CHECK ((status IN ('active','refreshing'))=(encrypted_tokens IS NOT NULL)),
  CHECK (encrypted_tokens IS NULL OR encrypted_tokens ?& ARRAY['keyId','iv','tag','data'] AND encrypted_tokens - ARRAY['keyId','iv','tag','data']='{}'::jsonb)
);
-- A GitHub identity can have only one unreleased website binding for each App.
CREATE UNIQUE INDEX m06_github_authorization_credentials_identity_unique ON m06_github_authorization_credentials(app_id,github_user_id) WHERE status<>'revoked' OR revocation_pending;
CREATE TABLE m06_github_authorization_events (
  id uuid PRIMARY KEY, user_id text NOT NULL, app_id bigint NOT NULL,
  github_user_id bigint CHECK (github_user_id IS NULL OR github_user_id>0),
  credential_revision integer CHECK (credential_revision IS NULL OR credential_revision>0),
  event_type text NOT NULL CHECK (event_type IN ('GitHubAuthorizationBound','GitHubTokensRefreshed','GitHubAuthorizationRevoked','GitHubReauthorizationRequired','GitHubRefreshClaimed')),
  details jsonb NOT NULL CHECK (jsonb_typeof(details)='object' AND octet_length(details::text)<=2048),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (details - ARRAY['status','previousStatus','authorizationEpoch','leaseUntil']='{}'::jsonb)
);
CREATE INDEX m06_github_authorization_events_owner ON m06_github_authorization_events(user_id,app_id,occurred_at DESC);
-- All writes that touch epochs lock epochs before credentials/state rows. Expired refresh leases require reauthorization, never automatic refresh replay.
-- revokeCredential reserves the identity while remote grant revocation is in flight; finishRevocation clears both flags atomically for the matching epoch.
-- Coordinator adds M01/M02 FK names after matching its actual schema. Retention/purge applies to states; event retention is a separate policy.
-- Rollback requires coordinated backup: DROP TABLE m06_github_authorization_events,m06_github_authorization_credentials,m06_github_authorization_states,m06_github_authorization_epochs;

-- SQL proposal only; the coordinator owns actual migrations and foreign-key integration.
CREATE TABLE github_repository_creation_operations (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  user_id text NOT NULL,
  idempotency_key text NOT NULL,
  input_hash text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, user_id, idempotency_key),
  CHECK (payload->>'status' IN ('preview','creating','created','blocked','unknown')),
  CHECK (payload->>'autoInit' = 'true'),
  CHECK ((payload->>'revision')::integer = revision),
  CHECK (payload->>'projectId' = project_id AND payload->>'userId' = user_id AND payload->>'id' = id),
  CHECK (NOT (payload ?| ARRAY['token','accessToken','refreshToken','credential','clientSecret']))
);
CREATE INDEX github_repository_creation_project ON github_repository_creation_operations (project_id, user_id, created_at DESC);
CREATE TABLE github_repository_creation_audit (
  id text PRIMARY KEY,
  operation_id text NOT NULL REFERENCES github_repository_creation_operations(id),
  project_id text NOT NULL,
  user_id text NOT NULL,
  revision integer NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('RepositoryCreated','RepositoryCreationUpdated')),
  details jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id, revision)
);
-- Audit is append-only; production role should have INSERT/SELECT and no UPDATE/DELETE permission.
-- Rollback requires preserving private operation/audit history before dropping audit then operations.
