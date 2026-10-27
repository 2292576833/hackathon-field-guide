-- Migration suggestion only. Root applies an incremental migration.
CREATE TABLE team_supervision_settings (
  user_id text NOT NULL, project_id text NOT NULL, membership_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT false, revision integer NOT NULL CHECK (revision >= 1),
  hold_request_id text, last_started_at timestamptz, updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, project_id)
);
CREATE TABLE team_supervision_runs (
  user_id text NOT NULL, project_id text NOT NULL, membership_id text NOT NULL,
  request_id text NOT NULL, facts_fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','succeeded','failed','unknown')),
  started_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, finished_at timestamptz,
  message_id text, response_text text, error_code text,
  PRIMARY KEY (user_id, project_id, request_id),
  UNIQUE (user_id, project_id, facts_fingerprint)
);
CREATE INDEX team_supervision_runs_recent ON team_supervision_runs(user_id, project_id, started_at DESC);
