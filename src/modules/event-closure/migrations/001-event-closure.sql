-- 001 · 赛后闭环：队伍「是否愿意被联系」（event-closure 模块的**迁移建议**）
--
-- 本文件不是已部署迁移：由主会话分配递增编号（最新为 071，建议 072）写入根 `migrations/` 后执行。
-- 风格参考 `migrations/071_result_appeals.sql`：JSONB document + 索引化身份列 + 文档一致性 CHECK +
-- 不可变触发器 + 部分唯一索引。
--
-- 存储选型（规划 33 P09 第 4 节要求二选一，**不得两处并存**）：
--   选择「**本模块内新表**」。不并入既有 `ej_result_appeals`——那张表管"结果申诉"，是另一件事；
--   两处同时存"联系意愿"会违反宪法 XII 的单一事实来源。
--
-- 本表是赛后闭环的**唯一新增事实**。除本表外，模块不写入任何其他表；
-- 主办方成果清单、下一届可复用、队伍侧赛后清单全部是只读派生，不落库。
--
-- 不可变边界：队伍、提交人、提交时间、原始选择与重试标识不可改写；
-- 撤回只允许 active -> withdrawn 且 revision 加一；历史行保留，可追溯"撤回后可重提"。

CREATE TABLE ecl_contact_willingness (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  team_id text NOT NULL,
  author_user_id text NOT NULL REFERENCES auth_users(id),
  willing boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('active','withdrawn')),
  revision integer NOT NULL CHECK (revision > 0),
  submitted_at timestamptz NOT NULL,
  withdrawn_at timestamptz,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  UNIQUE (organization_id, event_id, id),
  UNIQUE (organization_id, event_id, author_user_id, idempotency_key),
  FOREIGN KEY (event_id, organization_id) REFERENCES organizer_hosted_events(id, organization_id),
  FOREIGN KEY (event_id, team_id) REFERENCES event_registration_teams(event_id, id),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'teamId') IS NOT DISTINCT FROM team_id),
  CHECK ((document->>'authorUserId') IS NOT DISTINCT FROM author_user_id),
  CHECK ((document->>'willing')::boolean IS NOT DISTINCT FROM willing),
  CHECK ((document->>'status') IS NOT DISTINCT FROM status),
  CHECK ((document->>'revision')::integer IS NOT DISTINCT FROM revision),
  CHECK ((document->>'idempotencyKey') IS NOT DISTINCT FROM idempotency_key),
  CHECK ((status = 'active') = (withdrawn_at IS NULL))
);
CREATE INDEX ecl_contact_willingness_scope_time ON ecl_contact_willingness(organization_id, event_id, submitted_at, id);
-- 一队一条有效记录；撤回后（status<>'active'）可重新提交，旧行保留为历史。
CREATE UNIQUE INDEX ecl_contact_willingness_one_active ON ecl_contact_willingness(organization_id, event_id, team_id) WHERE status = 'active';

CREATE FUNCTION ecl_protect_contact_willingness() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.event_id IS DISTINCT FROM OLD.event_id
    OR NEW.team_id IS DISTINCT FROM OLD.team_id
    OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
    OR NEW.willing IS DISTINCT FROM OLD.willing
    OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
  THEN
    RAISE EXCEPTION 'event closure contact willingness scope, author and original choice are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'event closure contact willingness revision must increase by one' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'active' OR NEW.status <> 'withdrawn' THEN
    RAISE EXCEPTION 'event closure contact willingness can only move from active to withdrawn' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ecl_contact_willingness_identity_frozen BEFORE UPDATE ON ecl_contact_willingness
  FOR EACH ROW EXECUTE FUNCTION ecl_protect_contact_willingness();
