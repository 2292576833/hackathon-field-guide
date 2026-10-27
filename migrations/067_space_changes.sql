-- SQL suggestion only. Root assigns and applies a new incremental migration.
CREATE TABLE space_change_heads (
  project_id text PRIMARY KEY,
  revision integer NOT NULL CHECK (revision > 0),
  snapshot jsonb NOT NULL,
  recorded_at timestamptz NOT NULL
);
CREATE TABLE space_change_versions (
  project_id text NOT NULL REFERENCES space_change_heads(project_id),
  version integer NOT NULL CHECK (version > 0),
  snapshot jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, version)
);
CREATE TABLE space_changes (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  version integer NOT NULL,
  change_key text NOT NULL,
  body jsonb NOT NULL,
  UNIQUE (project_id, version, change_key),
  UNIQUE (id, project_id),
  FOREIGN KEY (project_id, version) REFERENCES space_change_versions(project_id, version)
);
CREATE TABLE space_change_recipients (
  change_id text NOT NULL,
  project_id text NOT NULL,
  membership_id text NOT NULL,
  user_id text NOT NULL,
  snapshot jsonb NOT NULL,
  PRIMARY KEY (change_id, membership_id),
  UNIQUE (change_id, membership_id, user_id),
  FOREIGN KEY (change_id, project_id) REFERENCES space_changes(id, project_id)
);
CREATE INDEX space_change_recipient_lookup ON space_change_recipients(project_id, membership_id, user_id);
CREATE TABLE space_change_acknowledgements (
  change_id text NOT NULL,
  membership_id text NOT NULL,
  user_id text NOT NULL,
  acknowledged_at timestamptz NOT NULL,
  PRIMARY KEY (change_id, membership_id),
  FOREIGN KEY (change_id, membership_id, user_id)
    REFERENCES space_change_recipients(change_id, membership_id, user_id)
);
CREATE FUNCTION space_changes_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Space change history is immutable';
END;
$$;
CREATE TRIGGER space_change_versions_immutable BEFORE UPDATE OR DELETE ON space_change_versions
  FOR EACH ROW EXECUTE FUNCTION space_changes_reject_mutation();
CREATE TRIGGER space_changes_immutable BEFORE UPDATE OR DELETE ON space_changes
  FOR EACH ROW EXECUTE FUNCTION space_changes_reject_mutation();
CREATE TRIGGER space_change_recipients_immutable BEFORE UPDATE OR DELETE ON space_change_recipients
  FOR EACH ROW EXECUTE FUNCTION space_changes_reject_mutation();
CREATE TRIGGER space_change_acknowledgements_immutable BEFORE UPDATE OR DELETE ON space_change_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION space_changes_reject_mutation();
