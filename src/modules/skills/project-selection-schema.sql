-- Suggested ROOT/M02-owned storage only, never accessed by the skills module.
-- Root selects migration sequence, actual Project FK, grants and transaction adapter.
CREATE TABLE IF NOT EXISTS project_skill_selections (
  project_id text PRIMARY KEY,
  revision integer NOT NULL CHECK(revision > 0),
  document jsonb NOT NULL,
  CHECK ((jsonb_typeof(document) = 'object') IS TRUE),
  CHECK ((document->>'projectId' = project_id) IS TRUE),
  CHECK (((document->>'revision')::integer = revision) IS TRUE),
  CHECK ((jsonb_typeof(document->'selections') = 'array') IS TRUE)
);
CREATE TABLE IF NOT EXISTS project_skill_selection_history (
  project_id text NOT NULL,
  revision integer NOT NULL CHECK(revision > 0),
  document jsonb NOT NULL,
  PRIMARY KEY(project_id,revision)
);
-- tx.save CAS and immutable history must commit with active session/membership,
-- project archive/read-only guards and fixed reference validation on the same executor.
-- Clearing keeps an empty selections array and advances revision; do not DELETE the row.
