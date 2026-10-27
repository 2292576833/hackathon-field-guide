-- Incremental suggestion only. Root adds this to a NEW migration; do not rewrite applied migrations.
CREATE TABLE IF NOT EXISTS skill_candidates (
  kind text NOT NULL CHECK(kind IN ('skill','bundle')),
  id text NOT NULL, version_id text NOT NULL, revision integer NOT NULL CHECK(revision>0),
  content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'), document jsonb NOT NULL,
  PRIMARY KEY(kind,id,version_id),
  CHECK ((jsonb_typeof(document) = 'object') IS TRUE),
  CHECK ((document->>'kind' = kind AND document->>'id' = id AND document->>'versionId' = version_id) IS TRUE),
  CHECK (((document->>'revision')::integer = revision AND document->>'contentHash' = content_hash) IS TRUE),
  CHECK ((document->>'manifestHash' ~ '^[a-f0-9]{64}$' AND document->>'state' IN ('draft','published','withdrawn')) IS TRUE)
);
CREATE TABLE IF NOT EXISTS skill_candidate_history (
  kind text NOT NULL, id text NOT NULL, version_id text NOT NULL, revision integer NOT NULL,
  document jsonb NOT NULL, PRIMARY KEY(kind,id,version_id,revision)
);
CREATE TABLE IF NOT EXISTS skill_publication_operations (
  operation_id text PRIMARY KEY, fingerprint text NOT NULL, result jsonb NOT NULL,
  occurred_at timestamptz NOT NULL
);
