-- 073 · 作品展示：队伍本人对作品公开范围的选择（P2 模块的根增量迁移）
--
-- 依据：规划 34 §3 C① 与宪法 v1.23.0 原则 XIII「作品公开与点评」。
-- 本迁移只新增**一张表与一个守卫触发器**——作品展示的唯一新增事实：
-- 「队伍本人选择公开范围」。默认不公开；主办方只能通过赛事级开关决定本场是否允许这件事。
--
-- 公开投影只含队伍逐项勾选的字段；联系人/邮箱/答卷/求助/住宿/队伍专属反馈/评委身份在结构上不可达。
-- 点评（文字留言与数值互评）不在本迁移内（P5/P7 未做）。
--
-- 与模块 `src/modules/event-judging/migrations/003-work-disclosure.sql` 保持一致（由主会话编号并应用）。
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

