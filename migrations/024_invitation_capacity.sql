-- U02 suggestion: apply as a NEW coordinator-owned root migration after the original M02 schema.
ALTER TABLE projects_invitation ADD COLUMN max_uses integer NOT NULL DEFAULT 1;
ALTER TABLE projects_invitation ADD COLUMN used_uses integer NOT NULL DEFAULT 0;
UPDATE projects_invitation SET used_uses = 1 WHERE status = 'accepted';
ALTER TABLE projects_invitation ADD CONSTRAINT projects_invitation_usage_valid CHECK (max_uses BETWEEN 1 AND 50 AND used_uses BETWEEN 0 AND max_uses);
ALTER TABLE projects_invitation ADD CONSTRAINT projects_invitation_capacity_state CHECK (
  (status = 'pending' AND used_uses < max_uses) OR (status = 'accepted' AND used_uses = max_uses) OR status = 'revoked'
);
CREATE TABLE projects_invitation_acceptance (
  invitation_id text NOT NULL REFERENCES projects_invitation(id) ON DELETE RESTRICT,
  user_id text NOT NULL,
  accepted_at timestamptz NOT NULL,
  PRIMARY KEY (invitation_id, user_id)
);
-- Legacy accepted rows already represented one consumed invitation. Preserve that history.
INSERT INTO projects_invitation_acceptance (invitation_id, user_id, accepted_at)
  SELECT id, accepted_by, accepted_at FROM projects_invitation WHERE status = 'accepted';

CREATE FUNCTION projects_check_invitation_usage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE invitation_key text; quota integer; consumed integer; actual integer;
BEGIN
  IF TG_TABLE_NAME = 'projects_invitation' THEN invitation_key := NEW.id;
  ELSE invitation_key := NEW.invitation_id; END IF;
  SELECT max_uses, used_uses INTO quota, consumed FROM projects_invitation WHERE id = invitation_key FOR UPDATE;
  SELECT count(*) INTO actual FROM projects_invitation_acceptance WHERE invitation_id = invitation_key;
  IF consumed <> actual OR actual > quota THEN
    RAISE EXCEPTION 'Invitation usage must match immutable acceptances' USING ERRCODE = '23514', CONSTRAINT = 'projects_invitation_usage_matches';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER projects_invitation_usage_matches
  AFTER INSERT OR UPDATE ON projects_invitation DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION projects_check_invitation_usage();
CREATE CONSTRAINT TRIGGER projects_invitation_acceptance_usage_matches
  AFTER INSERT ON projects_invitation_acceptance DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION projects_check_invitation_usage();
CREATE FUNCTION projects_keep_invitation_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Invitation acceptances are immutable' USING ERRCODE = '23514'; END;
$$;
CREATE TRIGGER projects_keep_invitation_acceptance
  BEFORE UPDATE OR DELETE ON projects_invitation_acceptance
  FOR EACH ROW EXECUTE FUNCTION projects_keep_invitation_acceptance();
