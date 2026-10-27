-- U02 suggestion only. Coordinator assigns the next root migration number (currently 022).
-- Existing immutable M03 rule JSONB accepts optional officialTracks; old snapshots are not updated.
CREATE TABLE projects_member_intention (
  project_id text NOT NULL REFERENCES projects_project(id),
  user_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  PRIMARY KEY (project_id, user_id),
  CHECK (body->>'projectId' = project_id AND body->>'userId' = user_id AND (body->>'revision')::integer = revision)
);
CREATE TABLE projects_member_intention_history (
  project_id text NOT NULL REFERENCES projects_project(id),
  user_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  PRIMARY KEY (project_id, user_id, revision),
  CHECK (body->>'projectId' = project_id AND body->>'userId' = user_id AND (body->>'revision')::integer = revision)
);
CREATE TABLE projects_track_selection (
  project_id text PRIMARY KEY REFERENCES projects_project(id),
  revision integer NOT NULL CHECK (revision > 0),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  CHECK (body->>'projectId' = project_id AND (body->>'revision')::integer = revision)
);
CREATE TABLE projects_track_selection_history (
  project_id text NOT NULL REFERENCES projects_project(id),
  revision integer NOT NULL CHECK (revision > 0),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  PRIMARY KEY (project_id, revision),
  CHECK (body->>'projectId' = project_id AND (body->>'revision')::integer = revision)
);
-- Payload contains revisions and review markers, never private answers.
-- Extend the existing enum-like constraint via a NEW migration; do not rewrite 001_initial.sql.
ALTER TABLE projects_change_fact DROP CONSTRAINT projects_change_fact_type_check;
ALTER TABLE projects_change_fact ADD CONSTRAINT projects_change_fact_type_check CHECK (
  type IN ('ProjectCreated','ProjectScopeChanged','ProjectMemberJoined','ProjectMemberLeft',
    'ProjectMemberRoleChanged','MemberAvailabilityChanged','ProjectStageChanged','ProjectResourceBookmarked',
    'MemberIntentionChanged','ProjectTrackSelectionChanged')
);
