-- 080 · 主办方专属页（规划 35）的根增量迁移
--
-- 依据：`docs/规划/35-主办方自助建站与AI页面生成.md` §10 与宪法 v1.24.0 原则 XIV。
-- 只存「怎么展示」，不存任何赛事业务事实：报名、队伍、收件、评审结果仍由各自模块持有。
-- 发布 = 把当前草稿打成不可变快照；草稿与线上分离；停用不删除记录。

CREATE TABLE organizer_page_specs (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizer_organizations(id),
 event_id text NOT NULL,
 -- 不透明短码；重置后旧链接立即失效。唯一且不可为空。
 short_code text NOT NULL CHECK(short_code ~ '^[A-Za-z0-9]{8,32}$'),
 status text NOT NULL CHECK(status IN ('draft','published','suspended')),
 revision integer NOT NULL CHECK(revision > 0),
 -- 草稿：主办方正在编辑的规格；线上：已发布的不可变快照。
 draft jsonb NOT NULL CHECK(jsonb_typeof(draft)='object'),
 published jsonb CHECK(published IS NULL OR jsonb_typeof(published)='object'),
 published_revision integer CHECK(published_revision IS NULL OR published_revision > 0),
 published_at timestamptz,
 -- 停用：主办方自行停用或平台管理员停用；记录不停用数据。
 suspended_at timestamptz,
 suspended_by text REFERENCES auth_users(id),
 -- 停用级别是**治理事实**：平台停用的页面主办方不能自行恢复。
 suspended_kind text,
 suspended_reason text,
 -- 平台停用的页面，主办方不能自行恢复（由应用层判定 suspended_by 是否为平台管理员）。
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 UNIQUE(event_id),
 UNIQUE(short_code),
 FOREIGN KEY(event_id, organization_id) REFERENCES organizer_hosted_events(id, organization_id),
 -- 发布态一致：published 与 published_revision/published_at 同生同灭。
 -- 快照与版本同生同灭：停用要保留线上内容证据与发布历史。
 CHECK((published IS NULL) = (published_revision IS NULL)),
 -- 「最近上线时间」只在 published 时存在；草稿与停用一律 NULL。
 CHECK(published_at IS NULL OR status = 'published'),
 CHECK(status <> 'published' OR (published IS NOT NULL AND published_revision IS NOT NULL AND published_at IS NOT NULL)),
 -- 停用态一致：suspended_at / suspended_by / suspended_kind 三者同生同灭。
 CHECK((status = 'suspended') = (suspended_at IS NOT NULL AND suspended_by IS NOT NULL AND suspended_kind IS NOT NULL)),
 CHECK(suspended_kind IS NULL OR suspended_kind IN ('organizer','platform'))
);
CREATE INDEX organizer_page_specs_organization ON organizer_page_specs(organization_id, updated_at DESC);

CREATE TABLE organizer_page_templates (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizer_organizations(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
 revision integer NOT NULL CHECK(revision > 0),
 -- 只存规格快照；套用=复制，不建立跨赛事联动。
 spec jsonb NOT NULL CHECK(jsonb_typeof(spec)='object'),
 created_by text NOT NULL REFERENCES auth_users(id),
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 UNIQUE(organization_id, name)
);
CREATE INDEX organizer_page_templates_organization ON organizer_page_templates(organization_id, updated_at DESC);
