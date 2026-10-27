-- M01 migration proposal. The coordinator owns execution/versioning and backups.
-- IDs are shared opaque text IDs; other modules reference auth_users(id) by agreement.
CREATE TABLE auth_users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) <= 254),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  -- 昵称是否由用户自己改过：观猹首次关联只在未改过时继承观猹昵称（迁移 070 已加到真实库）。
  display_name_customized boolean NOT NULL DEFAULT false,
  timezone text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deletion_pending', 'deleted')),
  platform_roles text[] NOT NULL DEFAULT ARRAY['user']::text[]
    CHECK (cardinality(platform_roles) > 0 AND platform_roles <@ ARRAY['user', 'reviewer', 'admin']::text[]),
  email_verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0)
);

CREATE TABLE auth_login_challenges (
  id text PRIMARY KEY,
  email text NOT NULL,
  email_rate_key text NOT NULL,
  code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  delivery text NOT NULL CHECK (delivery IN ('pending', 'ready', 'failed')),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  consumed_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX auth_login_challenges_email ON auth_login_challenges (email)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX auth_login_challenges_expiry ON auth_login_challenges (expires_at);

CREATE TABLE auth_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  authenticated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  revoked_at timestamptz
);
CREATE INDEX auth_sessions_user ON auth_sessions (user_id, created_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_expiry ON auth_sessions (expires_at);

-- HMAC-derived mailbox/client identifiers, with prefix for persistent verify-mailbox budgets.
CREATE TABLE auth_rate_limits (
  key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts >= 0),
  last_attempt_at timestamptz
);

-- No email address, code, token/hash, headers, raw IP, or provider exception payload.
CREATE TABLE auth_audit_events (
  id text PRIMARY KEY,
  actor_id text,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  result text NOT NULL,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX auth_audit_events_actor ON auth_audit_events (actor_id, occurred_at DESC);

-- Rollback requires a backup and coordinated module reference check first.
-- In reverse creation order: auth_audit_events, auth_rate_limits,
-- auth_sessions, auth_login_challenges, auth_users. Never auto-drop shared identities.
-- Schedule expiry cleanup in coordinator scripts only after retention policy is agreed;
-- keep rate rows at least a whole rate window/cooldown past their last attempt.
