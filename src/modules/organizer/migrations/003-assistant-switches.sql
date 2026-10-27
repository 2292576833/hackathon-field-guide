-- O01 / 规划34 P4 migration proposal only. Root numbers and executes the actual migration.
-- 赛事级模块助手开关（宪法 XIII「主办方自治、模块助手与选手社区」；规划34 §2.1 / §5.1）。
-- 内部运营项：即时生效、写既有 organizer_audit_events、**不随正式发布版本冻结**
-- （不在 EventModuleFlags / EventCommunityConfig / 赛事发布快照里，因此改动开关不改变已发布版本语义）。
-- 只新增这一张表：不改既有表，不建权限事实，不复制第二份助手注册表（assistant_key 由调用方传入）。
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
