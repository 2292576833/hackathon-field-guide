-- 081 · 主办方专属页的**草稿历史**（规划35 §6.3 / §16 P4「版本回退」）
-- 宪法 v1.24.0：XIII（主办方自治与审计）、XIV（内容归属：草稿归主办方）
--
-- 是什么：每次保存草稿（含建页、套用模板、回退）在同一事务里写一条，供「版本历史 / 回退到这一版」。
-- 不是什么：不是发布快照（线上内容仍只在 organizer_page_specs.published，本表没有 published 列），
--           也不是第二套写路径（回退只写 organizer_page_specs.draft）。

CREATE TABLE organizer_page_revisions (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizer_organizations(id),
 event_id text NOT NULL,
 -- 与 organizer_page_specs.revision 同一口径的草稿版本号；每赛事内唯一。
 revision integer NOT NULL CHECK(revision > 0),
 -- 只存一份 EventSitePageSpec（与 draft 同形状）：没有布局层、没有短码、没有可见性。
 spec jsonb NOT NULL CHECK(jsonb_typeof(spec)='object'),
 created_by text NOT NULL REFERENCES auth_users(id),
 created_at timestamptz NOT NULL,
 UNIQUE(event_id, revision),
 -- 赛事必须属于同一机构（与 organizer_page_specs 用同一条配对约束）。
 FOREIGN KEY(event_id, organization_id) REFERENCES organizer_hosted_events(id, organization_id)
);

-- 列表与裁剪都按 (event_id, revision DESC) 走索引。
CREATE INDEX organizer_page_revisions_event ON organizer_page_revisions(event_id, revision DESC);

-- 应用层不变量（SQL 表达不了，由 src/modules/event-site/history.ts 在同一事务里保证）：
-- ① 每赛事只保留最近 20 条（插入后同一事务裁剪）；
-- ② 写历史前过 normalizeSpec/serializeSpec，与写 draft 同一条闸门；
-- ③ revision 等于这次写入后的新 revision，历史号与草稿行一一对应；
-- ④ 回退读出的 spec 必须再过 normalizeSpec 才写回 draft；
-- ⑤ 列表只 SELECT revision/created_by/created_at，不返回 spec 正文。
