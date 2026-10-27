-- 087 · 机构级设置（白标等）：同一机构下所有赛事共享一个开关
CREATE TABLE organizer_settings (
  organization_id text PRIMARY KEY REFERENCES organizer_organizations(id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL
);
