-- 072 · 赛后闭环：队伍「是否愿意被联系」（P09 模块的根增量迁移）
--
-- 依据：规划 33 第 5 节第 6 期 / 分项 P09（缺口 N6）。
-- 本迁移只新增**一张表与一个守卫触发器**——赛后闭环的唯一新增事实：
-- 「队伍是否愿意被联系」。默认不公开，只对本场主办方可见；撤回可重提、历史保留；
-- 同一重试标识幂等；只有提交人本人可撤回；归档赛事只读。
--
-- 主办方成果清单、下一届可复用清单、队伍侧赛后清单全部是既有记录的只读派生，不落库；
-- 明确不承诺投资/录用/孵化，不把成绩当能力评价，也不新增完成状态或影响力分。
--
-- 与模块 `src/modules/event-closure/migrations/001-event-closure.sql` 保持一致（由主会话编号并应用）。
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
