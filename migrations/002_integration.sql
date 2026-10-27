-- Cross-module identities use M01 and project ownership uses M02.
ALTER TABLE projects_project ADD CONSTRAINT projects_creator_identity_fk FOREIGN KEY(created_by) REFERENCES auth_users(id);
ALTER TABLE projects_team ADD CONSTRAINT projects_team_creator_identity_fk FOREIGN KEY(created_by) REFERENCES auth_users(id);
ALTER TABLE projects_project_membership ADD CONSTRAINT projects_member_identity_fk FOREIGN KEY(user_id) REFERENCES auth_users(id);
ALTER TABLE projects_team_membership ADD CONSTRAINT projects_team_member_identity_fk FOREIGN KEY(user_id) REFERENCES auth_users(id);
ALTER TABLE projects_member_availability ADD CONSTRAINT projects_availability_identity_fk FOREIGN KEY(user_id) REFERENCES auth_users(id);
ALTER TABLE resource_bookmarks ADD CONSTRAINT resource_bookmark_identity_fk FOREIGN KEY(user_id) REFERENCES auth_users(id);
ALTER TABLE m03_project_rules ADD CONSTRAINT project_rules_project_fk FOREIGN KEY(id) REFERENCES projects_project(id);
ALTER TABLE planning_states ADD CONSTRAINT planning_project_fk FOREIGN KEY(project_id) REFERENCES projects_project(id);

-- Local development delivery only. Never enabled by connected/production runtime.
CREATE TABLE development_mailbox (
  id text PRIMARY KEY,
  recipient text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
