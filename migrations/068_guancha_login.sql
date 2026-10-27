-- Proposal only: coordinator chooses an additive root migration and applies it.
-- This file does not modify M01 accounts or imply provider/production readiness.
CREATE TABLE guancha_login_attempts (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  browser_binding_hash text NOT NULL CHECK (browser_binding_hash ~ '^[0-9a-f]{64}$'),
  issuer text NOT NULL,
  configuration_id text NOT NULL,
  redirect_uri text NOT NULL,
  return_to text NOT NULL,
  secret_ciphertext text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  consumed_at timestamptz,
  CHECK ((consumed_at IS NULL AND secret_ciphertext IS NOT NULL)
    OR (consumed_at IS NOT NULL AND secret_ciphertext IS NULL))
);
CREATE INDEX guancha_login_attempts_expiry ON guancha_login_attempts(expires_at);

-- Root identity adapter owns all cross-module account/session transactions.
-- Exact case-sensitive issuer+subject is the ONLY external identity key.
-- Never insert a binding based on an unverified email or display name.
CREATE TABLE guancha_identity_bindings (
  issuer text COLLATE "C" NOT NULL,
  subject text COLLATE "C" NOT NULL CHECK (length(subject) BETWEEN 1 AND 512),
  user_id text NOT NULL REFERENCES auth_users(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (issuer, subject),
  UNIQUE (issuer, user_id)
);

-- Pending association is never an account session. Root requires an active,
-- recently authenticated M01 session and an explicit same-origin confirmation.
CREATE TABLE guancha_pending_links (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  browser_binding_hash text NOT NULL CHECK (browser_binding_hash ~ '^[0-9a-f]{64}$'),
  issuer text COLLATE "C" NOT NULL,
  subject text COLLATE "C" NOT NULL CHECK (length(subject) BETWEEN 1 AND 512),
  return_to text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  consumed_at timestamptz
);
CREATE INDEX guancha_pending_links_expiry ON guancha_pending_links(expires_at);

-- Root maintenance may delete expired attempt rows after a chosen short
-- retention window. Never reset consumed_at or reclaim an exchanged attempt.

CREATE TABLE guancha_http_budgets (
  kind text PRIMARY KEY CHECK (kind IN ('begin','confirm')),
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 60)
);
