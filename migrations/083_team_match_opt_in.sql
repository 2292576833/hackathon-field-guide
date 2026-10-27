-- 083 · 智能组队大厅：本人是否愿意被组队（一人一场一行，没有行 = 未开启）
-- 规划 36 §2.3；宪法 XIII（默认关、本人可撤回）
CREATE TABLE tmt_team_match_opt_in (
  organization_id text NOT NULL REFERENCES organizer_organizations(id),
  event_id text NOT NULL,
  user_id text NOT NULL REFERENCES auth_users(id),
  open boolean NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (event_id, user_id),
  FOREIGN KEY (event_id, organization_id) REFERENCES organizer_hosted_events(id, organization_id)
);
