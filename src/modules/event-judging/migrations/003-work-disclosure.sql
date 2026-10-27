-- 003 · 作品展示「队伍可选公开」（event-judging 模块的**迁移建议**）
--
-- 本文件不是已部署迁移：由主会话分配递增编号（根最新为 072，建议 073）写入根 `migrations/` 后执行。
-- 风格与 `migrations/071_result_appeals.sql` / `072_event_closure.sql` 一致，并与模块
-- `src/modules/event-judging/schema.sql` 的同名定义**逐字保持一致**（两边不一致时以根迁移为准并回改 schema）。
--
-- 依据：规划 34 C①（`docs/规划/34-主办方模块化与选手社区.md` §3.1/§3.3/§3.4）与宪法 v1.23.0 原则 XIII。
-- 唯一新增事实是"队伍本人对本场作品的公开范围选择"。三层开关缺一不公开：
--   ① 赛事级 `community.workShowcase`（主办方，默认 false；本迁移不落该配置，它随正式发布版本冻结）；
--   ② 队伍级 scope（本表，private 默认 / participants / public）；
--   ③ 个人级点评（规划 34 P5/P7，**不在本批**，本迁移不建评论表）。
--
-- 本迁移只新增一张表、一个部分唯一索引、一个守卫触发器；**不改动任何既有表**，
-- 也不写第二份"作品公开状态"：公开投影是只读派生（`works.ts`），不落库。
--
-- 不可变边界：队伍、提交人、范围、逐项字段选择、提交时那一版正式收件与重试标识不可改写；
-- 只允许 active -> withdrawn 且 revision 加一；历史行保留，可追溯"撤回后可重提"。

CREATE TABLE ej_work_disclosures (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  team_id text NOT NULL,
  author_user_id text NOT NULL REFERENCES auth_users(id),
  scope text NOT NULL CHECK (scope IN ('private','participants','public')),
  status text NOT NULL CHECK (status IN ('active','withdrawn')),
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL,
  withdrawn_at timestamptz,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  UNIQUE (organization_id, event_id, id),
  UNIQUE (organization_id, event_id, author_user_id, idempotency_key),
  FOREIGN KEY (organization_id, event_id) REFERENCES ej_event_locks(organization_id, event_id),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'teamId') IS NOT DISTINCT FROM team_id),
  CHECK ((document->>'authorUserId') IS NOT DISTINCT FROM author_user_id),
  CHECK ((document->>'scope') IS NOT DISTINCT FROM scope),
  CHECK ((document->>'status') IS NOT DISTINCT FROM status),
  CHECK ((document->>'revision')::integer IS NOT DISTINCT FROM revision),
  CHECK ((document->>'idempotencyKey') IS NOT DISTINCT FROM idempotency_key),
  CHECK ((status = 'active') = (withdrawn_at IS NULL))
);
CREATE INDEX ej_work_disclosures_scope_time ON ej_work_disclosures(organization_id, event_id, updated_at, id);
-- 一队一条有效记录；撤回后（status <> 'active'）可重新提交，旧行保留为不可改写的历史。
CREATE UNIQUE INDEX ej_work_disclosures_one_active ON ej_work_disclosures(organization_id, event_id, team_id) WHERE status = 'active';

-- 原始选择与范围不可改写：范围、逐项字段、提交时那一版正式收件与重试标识冻结；
-- 只允许 active -> withdrawn 且版本加一。
CREATE FUNCTION ej_protect_work_disclosure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.event_id IS DISTINCT FROM OLD.event_id
    OR NEW.team_id IS DISTINCT FROM OLD.team_id
    OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
    OR NEW.scope IS DISTINCT FROM OLD.scope
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.document->'fields' IS DISTINCT FROM OLD.document->'fields'
    OR NEW.document->>'receiptId' IS DISTINCT FROM OLD.document->>'receiptId'
    OR NEW.document->>'receiptVersion' IS DISTINCT FROM OLD.document->>'receiptVersion'
  THEN
    RAISE EXCEPTION 'O04 work disclosure scope, selected fields and original receipt version are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'O04 work disclosure revision must increase by one' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'active' OR NEW.status <> 'withdrawn' THEN
    RAISE EXCEPTION 'O04 work disclosure can only move from active to withdrawn' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ej_work_disclosures_identity_frozen BEFORE UPDATE ON ej_work_disclosures
  FOR EACH ROW EXECUTE FUNCTION ej_protect_work_disclosure();

-- 回滚（仅在确认无人依赖本事实时使用）：
--   DROP TRIGGER ej_work_disclosures_identity_frozen ON ej_work_disclosures;
--   DROP FUNCTION ej_protect_work_disclosure();
--   DROP TABLE ej_work_disclosures;
