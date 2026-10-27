-- 085 · 插件接入（MCP）：个人访问令牌与调用审计
-- 宪法 XV：令牌只存哈希、可撤销即时生效、默认只读、ai:ask 单独授权并限流
CREATE TABLE mcp_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  call_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  CONSTRAINT mcp_tokens_scopes CHECK (scopes <@ ARRAY['events:read','me:read','hall:read','ai:ask']::text[] AND array_length(scopes,1) >= 1)
);
CREATE INDEX mcp_tokens_owner ON mcp_tokens(user_id, created_at DESC);

CREATE TABLE mcp_call_audit (
  id text PRIMARY KEY,
  token_id text NOT NULL REFERENCES mcp_tokens(id),
  user_id text NOT NULL REFERENCES auth_users(id),
  tool text NOT NULL CHECK (tool IN ('find_events','my_registrations','team_hall','submission_status','site_search','ask_specialist')),
  outcome text NOT NULL CHECK (outcome IN ('ok','denied','failed')),
  error_code text,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  occurred_at timestamptz NOT NULL
);
CREATE INDEX mcp_call_audit_token ON mcp_call_audit(token_id, occurred_at DESC);

-- ai:ask 当日计数（避免与既有 AI 账本混用；插件调用单独计量）
CREATE TABLE mcp_daily_ask (
  token_id text NOT NULL REFERENCES mcp_tokens(id),
  quota_day date NOT NULL,
  calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  PRIMARY KEY (token_id, quota_day)
);
