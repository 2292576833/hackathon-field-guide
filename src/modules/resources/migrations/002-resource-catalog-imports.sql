-- New suggestion only; do not rewrite an already-applied root migration.
CREATE TABLE resource_catalog_imports (
  candidate_key text PRIMARY KEY,
  revision integer NOT NULL CHECK (revision > 0),
  resource_id text NOT NULL REFERENCES resource_records(id) ON DELETE RESTRICT,
  document jsonb NOT NULL,
  CHECK ((jsonb_typeof(document) = 'object') IS TRUE),
  CHECK ((document->>'candidateKey' = candidate_key) IS TRUE),
  CHECK ((document->>'resourceId' = resource_id) IS TRUE),
  CHECK (((document->>'revision')::integer = revision) IS TRUE),
  CHECK ((document->>'stage' IN ('imported', 'submitted_for_review', 'approved', 'published')) IS TRUE)
);
-- Before rollback, preserve import history and resource/review references.
-- DROP TABLE resource_catalog_imports;
