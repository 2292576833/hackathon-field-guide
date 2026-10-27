CREATE TABLE IF NOT EXISTS skill_catalog (id text PRIMARY KEY, document jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS skill_bundles (id text PRIMARY KEY, document jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS skill_installation_plans (id text PRIMARY KEY, user_id text NOT NULL, revision integer NOT NULL CHECK(revision>0), document jsonb NOT NULL, bridge_token_hash text);
CREATE INDEX IF NOT EXISTS skill_plans_user ON skill_installation_plans(user_id);
CREATE TABLE IF NOT EXISTS skill_installation_receipts (id text PRIMARY KEY, plan_id text NOT NULL REFERENCES skill_installation_plans(id), user_id text NOT NULL, document jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS skill_receipts_user ON skill_installation_receipts(user_id);
CREATE TABLE IF NOT EXISTS skill_audit (id text PRIMARY KEY, actor_id text NOT NULL, action text NOT NULL, target_id text NOT NULL, occurred_at timestamptz NOT NULL, reason text NOT NULL);
