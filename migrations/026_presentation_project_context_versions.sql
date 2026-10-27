-- Derived, immutable versions of public project facts used for private presentation drafts.
CREATE TABLE presentation_project_context_versions (
  project_id text NOT NULL REFERENCES projects_project(id) ON DELETE RESTRICT,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  facts_fingerprint text NOT NULL CHECK (facts_fingerprint ~ '^[a-f0-9]{64}$'),
  facts_identity jsonb NOT NULL CHECK (jsonb_typeof(facts_identity) = 'object'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, revision),
  UNIQUE (project_id, facts_fingerprint)
);
CREATE FUNCTION presentation_context_keep_versions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Presentation context versions are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER presentation_context_keep_versions
  BEFORE UPDATE OR DELETE ON presentation_project_context_versions
  FOR EACH ROW EXECUTE FUNCTION presentation_context_keep_versions();
