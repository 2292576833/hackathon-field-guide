-- 071 · 参赛者对已公布结果的申诉（O04 模块的根增量迁移）
--
-- 依据：竞品源码把"申诉"作为公布之后独立的一步（Synnovator `.github/workflows/appeal.yml`）。
-- 我们此前只有主办方撤回/重开，选手没有正式通道。本迁移只新增一张表与一个守卫触发器：
-- 申诉是**新事实**，但绝不自动改变结果；分数更正仍必须走既有撤回 → 重新开放 → 补评 → 重新锁定 → 人工公布。
--
-- 与模块 `src/modules/event-judging/schema.sql` 的同名定义保持一致：状态与裁决可变，
-- 申诉范围、原始理由与时间不可改写；一条队伍对同一版公布结果只能有一条有效申诉。

CREATE TABLE ej_result_appeals (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  round_id text NOT NULL,
  published_result_id text NOT NULL,
  result_version integer NOT NULL CHECK (result_version > 0),
  team_id text NOT NULL,
  snapshot_id text NOT NULL,
  author_user_id text NOT NULL REFERENCES auth_users(id),
  status text NOT NULL CHECK (status IN ('submitted','accepted','rejected','handled','withdrawn')),
  revision integer NOT NULL CHECK (revision > 0),
  filed_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  UNIQUE (organization_id, event_id, id),
  UNIQUE (organization_id, event_id, author_user_id, idempotency_key),
  FOREIGN KEY (organization_id, event_id, round_id) REFERENCES ej_judging_rounds(organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id, published_result_id) REFERENCES ej_published_results(organization_id, event_id, id),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'roundId') IS NOT DISTINCT FROM round_id),
  CHECK ((document->>'publishedResultId') IS NOT DISTINCT FROM published_result_id),
  CHECK ((document->>'teamId') IS NOT DISTINCT FROM team_id),
  CHECK ((document->>'authorUserId') IS NOT DISTINCT FROM author_user_id),
  CHECK ((document->>'status') IS NOT DISTINCT FROM status),
  CHECK ((document->>'revision')::integer IS NOT DISTINCT FROM revision)
);
CREATE INDEX ej_result_appeals_scope_time ON ej_result_appeals(organization_id, event_id, filed_at, id);
CREATE UNIQUE INDEX ej_result_appeals_one_open ON ej_result_appeals(organization_id, event_id, published_result_id, team_id) WHERE status <> 'withdrawn';

CREATE FUNCTION ej_protect_appeal_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.round_id IS DISTINCT FROM OLD.round_id
    OR NEW.published_result_id IS DISTINCT FROM OLD.published_result_id
    OR NEW.team_id IS DISTINCT FROM OLD.team_id
    OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
    OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
    OR NEW.filed_at IS DISTINCT FROM OLD.filed_at
    OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.document->>'reason' IS DISTINCT FROM OLD.document->>'reason'
    OR NEW.document->>'requestedOutcome' IS DISTINCT FROM OLD.document->>'requestedOutcome'
  THEN
    RAISE EXCEPTION 'O04 appeal scope, original reason and timing are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'O04 appeal revision must increase by one' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'submitted' THEN
    RAISE EXCEPTION 'O04 settled appeals cannot be changed again' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ej_result_appeals_identity_frozen BEFORE UPDATE ON ej_result_appeals
  FOR EACH ROW EXECUTE FUNCTION ej_protect_appeal_identity();
