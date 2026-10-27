-- Project-local preparation notes retain the exact unverified discovery
-- snapshot. They do not create published M03 events or rule confirmations.
CREATE TABLE project_discovery_drafts (
  project_id text PRIMARY KEY REFERENCES projects_project(id),
  revision integer NOT NULL CHECK (revision > 0),
  body jsonb,
  updated_at timestamptz NOT NULL
);
CREATE TABLE project_discovery_draft_versions (
  project_id text NOT NULL REFERENCES project_discovery_drafts(project_id),
  revision integer NOT NULL CHECK (revision > 0),
  body jsonb,
  saved_by text NOT NULL REFERENCES auth_users(id),
  saved_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, revision)
);
