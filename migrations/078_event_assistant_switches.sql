-- 078 · 赛事级模块助手开关（P4 的根增量迁移）
--
-- 依据：规划 34 §5.1（「各流程模块助手开关 | 默认全开 | 比赛设置 → 模块助手 | 否（内部运营项，写审计）」）
-- 与宪法 v1.23.0 原则 XIII「主办方相关能力 MUST 在工作台逐项配置；内部运营项即时生效并写审计，不随正式发布版本冻结」。
--
-- 本迁移只新增一张表：**默认全开**（表里没有行即视为开启）；关闭/开启即时生效，每次改动写既有 organizer_audit_events。
-- 这些开关 MUST NOT 进入 EventConfigurationInput / 预览 / 发布 / changed-fields / 历史。
--
-- 与模块 `src/modules/organizer/migrations/003-assistant-switches.sql` 保持一致（由主会话编号并应用）。
CREATE TABLE organizer_event_assistant_switches (
 event_id text NOT NULL,
 organization_id text NOT NULL,
 -- 键取值由根从 module-assistants 注册表传入；这里只约束形状，不放第二份 key 清单。
 assistant_key text NOT NULL CHECK(assistant_key <> '' AND length(assistant_key) <= 120),
 enabled boolean NOT NULL,
 revision integer NOT NULL CHECK(revision > 0),
 updated_by_user_id text NOT NULL REFERENCES auth_users(id),
 updated_at timestamptz NOT NULL,
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
 -- 一赛事一助手键一行；同一键的并发写入靠这一主键与服务层 FOR UPDATE + expectedRevision。
 PRIMARY KEY(event_id, assistant_key),
 -- 与既有赛事表的复合外键一致：跨机构/不存在的赛事都无法挂上开关。
 FOREIGN KEY(event_id, organization_id) REFERENCES organizer_hosted_events(id, organization_id),
 -- document 与索引列必须一致：不存在"列说开、文档说关"的第二份事实。
 -- 每一项都先断言 jsonb 类型，避免缺键时 NULL 让 CHECK 静默通过。
 CHECK(document ? 'eventId' AND jsonb_typeof(document->'eventId') = 'string' AND document->>'eventId' = event_id
   AND document ? 'organizationId' AND jsonb_typeof(document->'organizationId') = 'string' AND document->>'organizationId' = organization_id
   AND document ? 'assistantKey' AND jsonb_typeof(document->'assistantKey') = 'string' AND document->>'assistantKey' = assistant_key
   AND document ? 'enabled' AND jsonb_typeof(document->'enabled') = 'boolean' AND document->'enabled' = to_jsonb(enabled)
   AND document ? 'revision' AND jsonb_typeof(document->'revision') = 'number' AND document->'revision' = to_jsonb(revision)
   AND document ? 'updatedByUserId' AND jsonb_typeof(document->'updatedByUserId') = 'string' AND document->>'updatedByUserId' = updated_by_user_id)
);
-- 机构维度的只读排查（本场开关集本身走主键前缀 event_id）。无触发器：开关必须可变，历史由审计承担。
CREATE INDEX organizer_event_assistant_switches_organization ON organizer_event_assistant_switches(organization_id, event_id);

