-- Proposal only. Coordinator copies into the next root migration; never apply from this module.
CREATE TABLE r02_team_feed_projects (
  project_id text PRIMARY KEY
);
CREATE TABLE r02_team_suggestions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES r02_team_feed_projects(project_id),
  author_user_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('discussion','adopted','withdrawn')),
  updated_at timestamptz NOT NULL,
  body jsonb NOT NULL CHECK (jsonb_typeof(body)='object')
);
CREATE INDEX r02_team_suggestions_feed ON r02_team_suggestions(project_id,updated_at DESC,id ASC);
CREATE TABLE r02_team_suggestion_versions (
  suggestion_id text NOT NULL REFERENCES r02_team_suggestions(id),
  revision integer NOT NULL CHECK (revision > 0),
  body jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY(suggestion_id,revision)
);
CREATE TABLE r02_team_suggestion_audit (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES r02_team_feed_projects(project_id),
  suggestion_id text NOT NULL REFERENCES r02_team_suggestions(id),
  actor_user_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('published','edited','withdrawn','adopted')),
  revision integer NOT NULL CHECK (revision > 0),
  occurred_at timestamptz NOT NULL
);
CREATE INDEX r02_team_suggestion_audit_project ON r02_team_suggestion_audit(project_id,occurred_at DESC);
CREATE TABLE r02_team_suggestion_idempotency (
  project_id text NOT NULL REFERENCES r02_team_feed_projects(project_id),
  scope text NOT NULL,
  key text NOT NULL,
  fingerprint text NOT NULL,
  receipt jsonb NOT NULL,
  PRIMARY KEY(project_id,scope,key)
);

