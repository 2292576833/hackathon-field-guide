-- M02 migration proposal only. The coordinator executes it with the actual migrations.
-- User/Event/Resource foreign keys are intentionally omitted until their owners' tables are agreed.
-- All IDs are opaque text. created_by records history and never grants authorization.

CREATE TABLE projects_team (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  created_by text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'dissolved')),
  revision integer NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE projects_team_membership (
  membership_id text PRIMARY KEY,
  team_id text NOT NULL REFERENCES projects_team(id) ON DELETE RESTRICT,
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('captain', 'member')),
  status text NOT NULL CHECK (status IN ('active', 'left', 'removed')),
  revision integer NOT NULL CHECK (revision > 0),
  joined_at timestamptz NOT NULL,
  left_at timestamptz,
  CONSTRAINT projects_team_user_unique UNIQUE (team_id, user_id),
  CHECK ((status = 'active' AND left_at IS NULL) OR (status <> 'active' AND left_at IS NOT NULL))
);
CREATE INDEX projects_team_member_user_active_idx ON projects_team_membership (user_id, team_id) WHERE status = 'active';

CREATE TABLE projects_project (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  team_id text REFERENCES projects_team(id) ON DELETE RESTRICT,
  event_id text,
  created_by text NOT NULL,
  goal text NOT NULL,
  minimum_deliverable text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('draft','preparing','active','finalizing','submitted','retrospective','archived')),
  timezone text NOT NULL CHECK (length(timezone) > 0),
  deadline timestamptz,
  deadline_source text NOT NULL CHECK (deadline_source IN ('member_entered','unknown')),
  revision integer NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK ((deadline IS NULL AND deadline_source = 'unknown') OR (deadline IS NOT NULL AND deadline_source = 'member_entered'))
);

CREATE TABLE projects_project_membership (
  membership_id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects_project(id) ON DELETE RESTRICT,
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('manager','member')),
  status text NOT NULL CHECK (status IN ('active','left','removed')),
  revision integer NOT NULL CHECK (revision > 0),
  joined_at timestamptz NOT NULL,
  left_at timestamptz,
  CONSTRAINT projects_project_user_unique UNIQUE (project_id, user_id),
  CHECK ((status = 'active' AND left_at IS NULL) OR (status <> 'active' AND left_at IS NOT NULL))
);
CREATE INDEX projects_project_member_user_active_idx ON projects_project_membership (user_id, project_id) WHERE status = 'active';

CREATE TABLE projects_invitation (
  id text PRIMARY KEY,
  scope_type text NOT NULL CHECK (scope_type IN ('project','team')),
  scope_id text NOT NULL,
  project_id text REFERENCES projects_project(id) ON DELETE RESTRICT,
  team_id text REFERENCES projects_team(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) > 0),
  role text NOT NULL,
  invited_email text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','accepted','revoked')),
  accepted_by text,
  accepted_at timestamptz,
  revoked_at timestamptz,
  revision integer NOT NULL CHECK (revision > 0),
  CHECK (expires_at > created_at),
  CHECK ((scope_type = 'project' AND project_id = scope_id AND project_id IS NOT NULL AND team_id IS NULL AND role IN ('manager','member'))
      OR (scope_type = 'team' AND team_id = scope_id AND team_id IS NOT NULL AND project_id IS NULL AND role IN ('captain','member'))),
  CHECK ((status = 'pending' AND accepted_by IS NULL AND accepted_at IS NULL AND revoked_at IS NULL)
      OR (status = 'accepted' AND accepted_by IS NOT NULL AND accepted_at IS NOT NULL AND revoked_at IS NULL)
      OR (status = 'revoked' AND accepted_by IS NULL AND accepted_at IS NULL AND revoked_at IS NOT NULL))
);
CREATE INDEX projects_invitation_scope_idx ON projects_invitation (scope_type, scope_id, id);

CREATE TABLE projects_member_availability (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects_project(id) ON DELETE RESTRICT,
  user_id text NOT NULL,
  timezone text NOT NULL CHECK (length(timezone) > 0),
  effective_minutes double precision NOT NULL CHECK (effective_minutes >= 0 AND effective_minutes < 'Infinity'::double precision),
  confirmed_at timestamptz NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  membership_revision integer NOT NULL CHECK (membership_revision > 0),
  CONSTRAINT projects_availability_member_unique UNIQUE (project_id, user_id),
  FOREIGN KEY (project_id, user_id) REFERENCES projects_project_membership(project_id, user_id) ON DELETE RESTRICT
);

-- Current collection snapshot only. A replaced/removed window does not alter existing outbox facts.
-- M05 owns validation and window semantics; M02 owns persistence and collection revision.
CREATE TABLE projects_availability_window (
  availability_id text NOT NULL REFERENCES projects_member_availability(id) ON DELETE RESTRICT,
  id text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  effective_minutes double precision NOT NULL CHECK (effective_minutes >= 0 AND effective_minutes < 'Infinity'::double precision),
  revision integer NOT NULL CHECK (revision > 0),
  PRIMARY KEY (availability_id, id),
  CHECK (ends_at > starts_at)
);

CREATE TABLE projects_resource_bookmark (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects_project(id) ON DELETE RESTRICT,
  resource_id text,
  resource_version integer,
  url text,
  title text NOT NULL,
  purpose_note text NOT NULL,
  saved_by text NOT NULL,
  saved_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('active','removed')),
  source_status text NOT NULL CHECK (source_status IN ('reviewed_resource','member_reference_unverified')),
  CHECK ((resource_id IS NULL AND resource_version IS NULL) OR (resource_id IS NOT NULL AND resource_version IS NOT NULL AND resource_version > 0)),
  revision integer NOT NULL CHECK (revision > 0),
  CHECK ((resource_id IS NOT NULL AND url IS NULL AND source_status = 'reviewed_resource')
      OR (resource_id IS NULL AND url IS NOT NULL AND source_status = 'member_reference_unverified'))
);
-- Include removed references so re-adding updates the historical row instead of duplicating it.
CREATE UNIQUE INDEX projects_bookmark_resource_unique ON projects_resource_bookmark (project_id, resource_id) WHERE resource_id IS NOT NULL;
CREATE UNIQUE INDEX projects_bookmark_url_unique ON projects_resource_bookmark (project_id, url) WHERE url IS NOT NULL;
CREATE INDEX projects_bookmark_project_idx ON projects_resource_bookmark (project_id, id);

CREATE TABLE projects_activity (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects_project(id) ON DELETE RESTRICT,
  actor_id text NOT NULL,
  type text NOT NULL,
  object_id text NOT NULL,
  before_summary jsonb NOT NULL CHECK (jsonb_typeof(before_summary) = 'object'),
  after_summary jsonb NOT NULL CHECK (jsonb_typeof(after_summary) = 'object'),
  occurred_at timestamptz NOT NULL,
  revision integer NOT NULL CHECK (revision > 0)
);
CREATE INDEX projects_activity_recent_idx ON projects_activity (project_id, occurred_at DESC, id DESC);

CREATE TABLE projects_change_fact (
  event_id text PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('ProjectCreated','ProjectScopeChanged','ProjectMemberJoined','ProjectMemberLeft','ProjectMemberRoleChanged','MemberAvailabilityChanged','ProjectStageChanged','ProjectResourceBookmarked')),
  aggregate_id text NOT NULL,
  project_id text NOT NULL REFERENCES projects_project(id) ON DELETE RESTRICT,
  actor_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  acknowledged_at timestamptz
);
CREATE INDEX projects_fact_pending_idx ON projects_change_fact (occurred_at, event_id) WHERE acknowledged_at IS NULL;

-- Deferred constraints permit create+initial manager and manager handoff in the same transaction.
-- Scope row locks make the manager/captain count safe against concurrent direct membership writes.
CREATE FUNCTION projects_require_active_manager() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  scope_id text;
  scope_stage text;
BEGIN
  IF TG_TABLE_NAME = 'projects_project' THEN
    IF TG_OP = 'DELETE' THEN scope_id := OLD.id; ELSE scope_id := NEW.id; END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN scope_id := OLD.project_id; ELSE scope_id := NEW.project_id; END IF;
  END IF;
  SELECT stage INTO scope_stage FROM projects_project WHERE id = scope_id FOR UPDATE;
  IF FOUND AND NOT EXISTS (
    SELECT 1 FROM projects_project_membership WHERE project_id = scope_id AND status = 'active' AND role = 'manager'
  ) THEN
    RAISE EXCEPTION 'Project requires an active manager' USING ERRCODE = '23514', CONSTRAINT = 'projects_active_manager_required';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER projects_project_manager_check AFTER INSERT OR UPDATE ON projects_project
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION projects_require_active_manager();
CREATE CONSTRAINT TRIGGER projects_membership_manager_check AFTER INSERT OR UPDATE OR DELETE ON projects_project_membership
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION projects_require_active_manager();

CREATE FUNCTION projects_require_active_captain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  scope_id text;
  scope_status text;
BEGIN
  IF TG_TABLE_NAME = 'projects_team' THEN
    IF TG_OP = 'DELETE' THEN scope_id := OLD.id; ELSE scope_id := NEW.id; END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN scope_id := OLD.team_id; ELSE scope_id := NEW.team_id; END IF;
  END IF;
  SELECT status INTO scope_status FROM projects_team WHERE id = scope_id FOR UPDATE;
  IF FOUND AND scope_status = 'active' AND NOT EXISTS (
    SELECT 1 FROM projects_team_membership WHERE team_id = scope_id AND status = 'active' AND role = 'captain'
  ) THEN
    RAISE EXCEPTION 'Active team requires a captain' USING ERRCODE = '23514', CONSTRAINT = 'projects_active_captain_required';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER projects_team_captain_check AFTER INSERT OR UPDATE ON projects_team
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION projects_require_active_captain();
CREATE CONSTRAINT TRIGGER projects_membership_captain_check AFTER INSERT OR UPDATE OR DELETE ON projects_team_membership
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION projects_require_active_captain();

-- Relation identity cannot move between scopes. This also protects the old scope's manager/captain
-- count when a writer bypasses the adapter; status and role updates remain the permitted workflow.
CREATE FUNCTION projects_preserve_membership_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'projects_project_membership' THEN
    IF ROW(NEW.membership_id, NEW.project_id, NEW.user_id) IS DISTINCT FROM ROW(OLD.membership_id, OLD.project_id, OLD.user_id) THEN
      RAISE EXCEPTION 'Project membership identity is immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF ROW(NEW.membership_id, NEW.team_id, NEW.user_id) IS DISTINCT FROM ROW(OLD.membership_id, OLD.team_id, OLD.user_id) THEN
      RAISE EXCEPTION 'Team membership identity is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER projects_project_member_identity_check BEFORE UPDATE ON projects_project_membership
  FOR EACH ROW EXECUTE FUNCTION projects_preserve_membership_identity();
CREATE TRIGGER projects_team_member_identity_check BEFORE UPDATE ON projects_team_membership
  FOR EACH ROW EXECUTE FUNCTION projects_preserve_membership_identity();

CREATE FUNCTION projects_preserve_scope_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.created_by, NEW.created_at) IS DISTINCT FROM ROW(OLD.id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'Scope identity and creation history are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER projects_project_identity_check BEFORE UPDATE ON projects_project
  FOR EACH ROW EXECUTE FUNCTION projects_preserve_scope_identity();
CREATE TRIGGER projects_team_identity_check BEFORE UPDATE ON projects_team
  FOR EACH ROW EXECUTE FUNCTION projects_preserve_scope_identity();

-- Suggested rollback, only after exporting data and removing dependent integration migrations:
-- DROP TABLE projects_change_fact, projects_activity, projects_resource_bookmark,
--   projects_availability_window, projects_member_availability, projects_invitation,
--   projects_project_membership, projects_project, projects_team_membership, projects_team;
-- DROP FUNCTION projects_require_active_manager(), projects_require_active_captain(),
--   projects_preserve_membership_identity(), projects_preserve_scope_identity();
