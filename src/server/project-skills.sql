-- Root migration suggestion: apply after M10 candidate-schema + M08 skill-review SQL.
-- No production migration is executed by this file's author.
CREATE TABLE IF NOT EXISTS project_skill_selections (
  project_id text PRIMARY KEY REFERENCES projects_project(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK(revision > 0),
  updated_by text NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL,
  document jsonb NOT NULL,
  CHECK ((jsonb_typeof(document) = 'object') IS TRUE),
  CHECK ((document->>'projectId' = project_id AND (document->>'revision')::integer = revision) IS TRUE),
  CHECK ((document->>'updatedBy' = updated_by AND (document->>'updatedAt')::timestamptz = updated_at) IS TRUE),
  CHECK ((jsonb_typeof(document->'selections') = 'array') IS TRUE)
);
CREATE TABLE IF NOT EXISTS project_skill_selection_history (
  project_id text NOT NULL REFERENCES projects_project(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK(revision > 0),
  saved_by text NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT,
  saved_at timestamptz NOT NULL,
  document jsonb NOT NULL,
  PRIMARY KEY(project_id,revision),
  CHECK ((document->>'projectId' = project_id AND (document->>'revision')::integer = revision) IS TRUE),
  CHECK ((document->>'updatedBy' = saved_by AND (document->>'updatedAt')::timestamptz = saved_at) IS TRUE)
);
CREATE OR REPLACE FUNCTION reject_project_skill_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Project skill selection history is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER project_skill_history_immutable BEFORE UPDATE OR DELETE ON project_skill_selection_history
FOR EACH ROW EXECUTE FUNCTION reject_project_skill_history_change();
