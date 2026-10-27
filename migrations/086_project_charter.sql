-- 086 · 项目框架卡（防跑偏的锚点）
-- 立项时由本人确认后锁定；改动必须显式升版本，AI 不能自己改
CREATE TABLE project_charters (
  project_id text PRIMARY KEY REFERENCES projects_project(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  goal text NOT NULL CHECK (char_length(goal) BETWEEN 1 AND 400),
  deliverables text[] NOT NULL DEFAULT '{}',
  acceptance text NOT NULL DEFAULT '',
  non_goals text[] NOT NULL DEFAULT '{}',
  timebox text NOT NULL DEFAULT '',
  locked boolean NOT NULL DEFAULT false,
  updated_by text NOT NULL REFERENCES auth_users(id),
  updated_at timestamptz NOT NULL
);
