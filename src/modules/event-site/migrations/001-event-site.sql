-- event-site · 主办方专属页（规划 35 P1）的**迁移建议**
-- 依据：docs/规划/35-主办方自助建站与AI页面生成.md §10、§11；宪法 v1.24.0 原则 XIV。
--
-- 本文件是**建议**，不是已应用迁移，编号由主会话决定。
--
-- 【现状 · 必读】
-- 根目录 migrations/080_event_site.sql 已存在，已建好两张表：
--   organizer_page_specs    （一赛事一条；draft / published 两态；revision；short_code；status）
--   organizer_page_templates（机构级模板，只存规格快照）
-- 因此**不要**再加第二套表。本文件只登记 P1 规格层对表结构的最小要求，
-- 并给出"若 080 尚未包含"时可用的一段补充约束（幂等，重复执行安全）。
--
-- 【分工】
-- - 本模块（src/modules/event-site/）只拥有**内存里的类型与规则**，没有任何 SQL 执行代码。
-- - 真正写库的是根：它必须先过 parseSpec / normalizeSpec 才能落库，见文末"应用层不变量"。

-- ------------------------------------------------------------------
-- 1. 表结构与 PageSpec 的对应关系
-- ------------------------------------------------------------------
-- organizer_page_specs.draft / .published 每个都是**一个 EventSitePageSpec 的 JSON**：
--   {"version":1,
--    "blocks":[
--      {"kind":"countdown","id":"b1","variant":"banner","priority":5,"collapse":false,
--       "heading":null,"text":null,"items":[],"image":null,
--       "binding":{"source":"eventSchedule","field":"registrationCloses"}},
--      {"kind":"actionRegister","id":"b2","variant":"primary","priority":5,"collapse":false,"action":"register"},
--      {"kind":"aiBlock","id":"b9","variant":"plain","priority":3,"collapse":false,
--       "manages":["b1"],"duty":"只管语气","mode":"edit","fullPage":false}
--    ]}
--
-- 表里**只存"怎么展示"**：没有报名截止、没有队伍、没有分数、没有评审维度。
-- 事实类区块只存 binding（读哪里），值在渲染时从既有只读投影取（宪法 XIV「事实与展示分离」）。

-- ------------------------------------------------------------------
-- 2. 可选补充约束（幂等；仅在 root 080 未包含时执行）
-- ------------------------------------------------------------------
-- 080 已保证：status ∈ (draft|published|suspended)、revision > 0、published 三件套同生同灭、
-- short_code 形如 ^[A-Za-z0-9]{8,32}$ 且唯一、event_id 唯一、停用不删数据。
-- 下面三条是 P1 规格层额外想要的"便宜不变量"（SQL 只能挡形状，挡不了语义）：

DO $$
BEGIN
  -- (a) 规格版本必须显式记为 1；将来升版时新增列值而不是改语义。
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizer_page_specs' AND column_name = 'spec_version'
  ) THEN
    ALTER TABLE organizer_page_specs ADD COLUMN spec_version integer NOT NULL DEFAULT 1;
    ALTER TABLE organizer_page_specs
      ADD CONSTRAINT organizer_page_specs_spec_version CHECK(spec_version = 1);
  END IF;

  -- (b) 草稿必须是"有 blocks 数组"的对象：挡掉把布局层或字符串误写进 jsonb。
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizer_page_specs_draft_shape'
  ) THEN
    ALTER TABLE organizer_page_specs
      ADD CONSTRAINT organizer_page_specs_draft_shape
      CHECK(jsonb_typeof(draft) = 'object' AND jsonb_typeof(draft -> 'blocks') = 'array');
  END IF;

  -- (c) 已发布快照与草稿同一形状（发布=快照，不是另一种结构）。
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizer_page_specs_published_shape'
  ) THEN
    ALTER TABLE organizer_page_specs
      ADD CONSTRAINT organizer_page_specs_published_shape
      CHECK(published IS NULL OR (jsonb_typeof(published) = 'object' AND jsonb_typeof(published -> 'blocks') = 'array'));
  END IF;

  -- (d) 模板同理：只存规格快照，不做跨赛事联动。
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizer_page_templates' AND column_name = 'spec_version'
  ) THEN
    ALTER TABLE organizer_page_templates ADD COLUMN spec_version integer NOT NULL DEFAULT 1;
  END IF;
END $$;

-- ------------------------------------------------------------------
-- 3. 应用层不变量（SQL 表达不了，必须由根在写入前执行）
-- ------------------------------------------------------------------
-- ① 写 draft 前：normalizeSpec(input)（宽容补齐缺省字段）→ 任何超限/未知字段直接 422。
--    发布前：parseSpec(draft)（严格形态）→ 通过才允许把 draft 拷进 published。
-- ② 序列化长度 ≤ 128KB（serializeSpec / specByteLength 抛 EVENT_SITE_SPEC_TOO_LARGE，413）。
-- ③ 一页最多 3 个 AI 组件；一块只能属于一个容器；折叠只有一层 —— 由 crossBlockRules 保证。
-- ④ 短码必须是**不可由赛事 id 推导**的随机串；重置短码只改短码，不动机上已发布快照。
-- ⑤ published 一旦写入即不可变；"继续编辑"只写 draft，"发布"新增 published_revision。
-- ⑥ 停用/恢复只改 status 与 suspended_*，不删除行、不改 draft/published。
-- ⑦ 审计：创建、发布、停用、恢复、回收短码各写一条既有主办方/平台审计（根负责）。
-- ⑧ 专属页默认 noindex（src/shared/noindex.ts 已有）；短码回收后旧链接立即失效。
