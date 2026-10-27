-- 076 · 作品文字留言（P5 模块的根增量迁移）
--
-- 依据：规划 34 §3 C② 与宪法 v1.23.0 原则 XIII「作品公开与点评（分列、不计入名次）」。
-- 本迁移只新增一张表与一个守卫触发器：文字留言**与数值互评分列**，绝不出现在汇总/名次/对外导出里。
-- 留言必须同时满足：赛事开启 workShowcase 与 peerFeedback，且该作品已被队伍本人选择公开。
--
-- 与模块 `src/modules/event-judging/migrations/004-work-comments.sql` 保持一致（由主会话编号并应用）。
CREATE TABLE ej_work_comments (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  team_id text NOT NULL,
  snapshot_id text NOT NULL,
  author_user_id text NOT NULL REFERENCES auth_users(id),
  status text NOT NULL CHECK (status IN ('active','hidden')),
  revision integer NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL,
  hidden_at timestamptz,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  UNIQUE (organization_id, event_id, id),
  UNIQUE (organization_id, event_id, author_user_id, idempotency_key),
  FOREIGN KEY (organization_id, event_id) REFERENCES ej_event_locks(organization_id, event_id),
  FOREIGN KEY (organization_id, event_id, snapshot_id) REFERENCES ej_intake_receipts(organization_id, event_id, id),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'teamId') IS NOT DISTINCT FROM team_id),
  CHECK ((document->>'snapshotId') IS NOT DISTINCT FROM snapshot_id),
  CHECK ((document->>'authorUserId') IS NOT DISTINCT FROM author_user_id),
  CHECK ((document->>'status') IS NOT DISTINCT FROM status),
  CHECK ((document->>'revision')::integer IS NOT DISTINCT FROM revision),
  CHECK ((document->>'idempotencyKey') IS NOT DISTINCT FROM idempotency_key),
  CHECK ((status = 'active') = (hidden_at IS NULL)),
  CHECK (length(document->>'text') BETWEEN 1 AND 4000)
);
CREATE INDEX ej_work_comments_scope_time ON ej_work_comments(organization_id, event_id, team_id, created_at, id);

-- 正文、作者与"写这条留言时的那一版作品"不可改写；只允许 active -> hidden 且版本加一。
-- 隐藏一次即幂等：服务层对已隐藏记录直接返回原记录，不产生第二次写入。
CREATE FUNCTION ej_protect_work_comment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.event_id IS DISTINCT FROM OLD.event_id
    OR NEW.team_id IS DISTINCT FROM OLD.team_id
    OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
    OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.document->>'text' IS DISTINCT FROM OLD.document->>'text'
    OR NEW.document->>'authorUserId' IS DISTINCT FROM OLD.document->>'authorUserId'
    OR NEW.document->>'teamId' IS DISTINCT FROM OLD.document->>'teamId'
    OR NEW.document->>'snapshotId' IS DISTINCT FROM OLD.document->>'snapshotId'
  THEN
    RAISE EXCEPTION 'O04 work comment author, text and original work version are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'O04 work comment revision must increase by one' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'active' OR NEW.status <> 'hidden' THEN
    RAISE EXCEPTION 'O04 work comment can only move from active to hidden' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ej_work_comments_identity_frozen BEFORE UPDATE ON ej_work_comments
  FOR EACH ROW EXECUTE FUNCTION ej_protect_work_comment();

-- 举报：只记录"某账号在某条留言上举报过"这一事实与可选说明。
-- 不改留言状态、不裁决、不封禁；同账号同留言只能有一条（重复举报幂等返回原记录）。
CREATE TABLE ej_work_comment_reports (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  comment_id text NOT NULL,
  reporter_user_id text NOT NULL REFERENCES auth_users(id),
  reason text NOT NULL CHECK (length(reason) <= 1000),
  created_at timestamptz NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  UNIQUE (organization_id, event_id, id),
  UNIQUE (organization_id, event_id, comment_id, reporter_user_id),
  FOREIGN KEY (organization_id, event_id, comment_id) REFERENCES ej_work_comments(organization_id, event_id, id),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'commentId') IS NOT DISTINCT FROM comment_id),
  CHECK ((document->>'reporterUserId') IS NOT DISTINCT FROM reporter_user_id),
  CHECK ((document->>'reason') IS NOT DISTINCT FROM reason)
);
CREATE INDEX ej_work_comment_reports_scope_time ON ej_work_comment_reports(organization_id, event_id, comment_id, created_at, id);
-- 举报是事实，没有 UPDATE/DELETE 入口。
CREATE FUNCTION ej_reject_comment_report_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'O04 work comment reports are append-only facts' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER ej_work_comment_reports_immutable BEFORE UPDATE OR DELETE ON ej_work_comment_reports
  FOR EACH ROW EXECUTE FUNCTION ej_reject_comment_report_change();

-- 回滚（仅在确认无人依赖本事实时使用）：
--   DROP TRIGGER ej_work_comment_reports_immutable ON ej_work_comment_reports;
--   DROP FUNCTION ej_reject_comment_report_change();
--   DROP TABLE ej_work_comment_reports;
--   DROP TRIGGER ej_work_comments_identity_frozen ON ej_work_comments;
--   DROP FUNCTION ej_protect_work_comment();
--   DROP TABLE ej_work_comments;

