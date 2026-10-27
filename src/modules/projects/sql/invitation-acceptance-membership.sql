-- C02 incremental suggestion. The coordinator must apply as a NEW root migration after 024.
-- Old acceptance facts cannot reliably identify their membership at acceptance time.
-- Leave them NULL: do not re-consume quota, infer identity, or revive a member.
ALTER TABLE projects_invitation_acceptance ADD COLUMN membership_id text;
CREATE INDEX projects_invitation_acceptance_membership_idx
  ON projects_invitation_acceptance (membership_id) WHERE membership_id IS NOT NULL;
COMMENT ON COLUMN projects_invitation_acceptance.membership_id IS
  'Actual membership at acceptance; NULL only for history that did not record this association';

-- This polymorphic reference is checked against the existing scope membership tables.
-- Existing facts remain immutable. New facts must refer to the active membership just joined.
CREATE FUNCTION projects_check_invitation_acceptance_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE invitation_scope_type text; invitation_scope_id text; linked_membership text;
BEGIN
  IF NEW.membership_id IS NULL OR btrim(NEW.membership_id) = '' THEN
    RAISE EXCEPTION 'New invitation acceptances require a membership association'
      USING ERRCODE = '23514', CONSTRAINT = 'projects_invitation_acceptance_membership_valid';
  END IF;
  SELECT scope_type, scope_id INTO invitation_scope_type, invitation_scope_id
    FROM projects_invitation WHERE id = NEW.invitation_id FOR SHARE;
  IF invitation_scope_type = 'project' THEN
    SELECT membership_id INTO linked_membership FROM projects_project_membership
      WHERE membership_id = NEW.membership_id AND project_id = invitation_scope_id
        AND user_id = NEW.user_id AND status = 'active' FOR SHARE;
  ELSIF invitation_scope_type = 'team' THEN
    SELECT membership_id INTO linked_membership FROM projects_team_membership
      WHERE membership_id = NEW.membership_id AND team_id = invitation_scope_id
        AND user_id = NEW.user_id AND status = 'active' FOR SHARE;
  END IF;
  IF linked_membership IS NULL THEN
    RAISE EXCEPTION 'Invitation acceptance membership must match its scope and user'
      USING ERRCODE = '23514', CONSTRAINT = 'projects_invitation_acceptance_membership_valid';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER projects_invitation_acceptance_membership_valid
  BEFORE INSERT ON projects_invitation_acceptance
  FOR EACH ROW EXECUTE FUNCTION projects_check_invitation_acceptance_membership();

-- Keep the polymorphic reference valid after the INSERT, like an ON DELETE RESTRICT FK.
-- Leaving/removing a member still updates its status and preserves the historical row.
CREATE FUNCTION projects_keep_accepted_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE membership_scope_type text; membership_scope_id text;
BEGIN
  IF TG_TABLE_NAME = 'projects_project_membership' THEN
    membership_scope_type := 'project'; membership_scope_id := OLD.project_id;
  ELSE
    membership_scope_type := 'team'; membership_scope_id := OLD.team_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM projects_invitation_acceptance a
      JOIN projects_invitation i ON i.id = a.invitation_id
      WHERE a.membership_id = OLD.membership_id
        AND i.scope_type = membership_scope_type AND i.scope_id = membership_scope_id
  ) THEN
    RAISE EXCEPTION 'Accepted membership history must be retained'
      USING ERRCODE = '23503', CONSTRAINT = 'projects_invitation_acceptance_membership_reference';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER projects_keep_accepted_project_membership
  BEFORE DELETE ON projects_project_membership
  FOR EACH ROW EXECUTE FUNCTION projects_keep_accepted_membership();
CREATE TRIGGER projects_keep_accepted_team_membership
  BEFORE DELETE ON projects_team_membership
  FOR EACH ROW EXECUTE FUNCTION projects_keep_accepted_membership();

-- An invitation's scope must not be moved away from its immutable acceptance facts.
CREATE FUNCTION projects_keep_accepted_invitation_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.scope_type, NEW.scope_id, NEW.project_id, NEW.team_id) IS DISTINCT FROM
     ROW(OLD.scope_type, OLD.scope_id, OLD.project_id, OLD.team_id)
     AND EXISTS (SELECT 1 FROM projects_invitation_acceptance WHERE invitation_id = OLD.id) THEN
    RAISE EXCEPTION 'Accepted invitation scope is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'projects_invitation_acceptance_scope_reference';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER projects_keep_accepted_invitation_scope
  BEFORE UPDATE ON projects_invitation
  FOR EACH ROW EXECUTE FUNCTION projects_keep_accepted_invitation_scope();
