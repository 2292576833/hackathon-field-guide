-- event-site · P4 草稿历史（organizer_page_revisions）的**迁移建议**
-- 依据：docs/规划/35-主办方自助建站与AI页面生成.md §6.3「实时预览与修改」、§16 P4「版本回退」；
-- 宪法 v1.24.0 原则 XIII（主办方自治与审计）、XIV（内容归属：草稿仍属主办方）。
--
-- 本文件是**建议**，不是已应用迁移：编号由主会话决定。
-- 根目录当前最新是 080_event_site.sql，建议编号 **081_event_site_revisions.sql**。
-- 本模块不执行任何 SQL；测试把本文件原文加载进临时内存 PGlite（不复制表结构）。
--
-- 【是什么 / 不是什么】
-- - 是：**草稿历史**。每次保存草稿（含建页那次、含套用模板、含回退）在同一事务里写一条。
-- - 不是：发布快照。发布快照仍然只在 organizer_page_specs.published（publish() 是它唯一的写入者），
--   本表**没有** published 列，因此不可能变成第二份线上事实。
-- - 不是：第二套写路径。回退只写 organizer_page_specs.draft，发布仍走既有 publish 与发布门槛。

CREATE TABLE organizer_page_revisions (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizer_organizations(id),
 event_id text NOT NULL,
 -- 与 organizer_page_specs.revision 同一口径的**草稿版本号**；每赛事内唯一。
 revision integer NOT NULL CHECK(revision > 0),
 -- 只存一份 EventSitePageSpec（与 draft 同一形状）：没有布局层、没有短码、没有可见性。
 spec jsonb NOT NULL CHECK(jsonb_typeof(spec)='object'),
 created_by text NOT NULL REFERENCES auth_users(id),
 created_at timestamptz NOT NULL,
 -- 历史号在赛事内唯一：回退产生的**新**草稿版本号不会与历史号冲突。
 UNIQUE(event_id, revision),
 -- 赛事必须属于同一机构（与 organizer_page_specs 用同一条配对约束）。
 FOREIGN KEY(event_id, organization_id) REFERENCES organizer_hosted_events(id, organization_id)
);

-- 列表与裁剪都按 (event_id, revision DESC) 走索引，不做全表扫描。
CREATE INDEX organizer_page_revisions_event ON organizer_page_revisions(event_id, revision DESC);

-- ------------------------------------------------------------------
-- 应用层不变量（SQL 表达不了，必须由 src/modules/event-site/history.ts 在同一事务里做）
-- ------------------------------------------------------------------
-- ① 保留窗口：每赛事只留最近 20 条（EVENT_SITE_REVISION_HISTORY_LIMIT）。
--    插入后在**同一事务**里 DELETE 窗口外的行，只删本赛事；被删版本号作为返回值，可逐条核对。
--    不用触发器：保留窗口是产品策略，改窗口只改一个常量，不需要迁移。
-- ② 写历史前必须过 normalizeSpec/serializeSpec（与写 draft 同一条闸门，128KB 上限同样适用）。
-- ③ revision 必须等于这次写入 organizer_page_specs 后的新 revision（同一事务读取返回值），
--    因此历史号与草稿行版本一一对应；发布、换短码、停用、恢复只会让 revision 前进，不写历史。
-- ④ 回退读出的 spec 必须再过 normalizeSpec 才能写回 draft（本模块 service.restoreRevision 已做）。
-- ⑤ 历史只读给 event_manage：列表只 SELECT revision/created_by/created_at，不返回 spec 正文。
