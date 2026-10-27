-- 004 · 作品文字留言（event-judging 模块的**迁移建议**）
--
-- 本文件不是已部署迁移：由主会话分配递增编号（根最新为 072，003 建议 073，本文件建议 074）写入根
-- `migrations/` 后执行。风格与 `migrations/071_result_appeals.sql` / `072_event_closure.sql` 一致，
-- 并与模块 `src/modules/event-judging/schema.sql` 的同名定义**逐字保持一致**（两边不一致时以根迁移为准并回改 schema）。
--
-- 依据：规划 34 C②（`docs/规划/34-主办方模块化与选手社区.md` §3.2 文字留言列 / §3.4）与宪法 v1.23.0 原则 XIII。
-- 与数值互评（P7）**分列**：本迁移只建"纯文字"留言表与"举报事实"表，**没有任何评分列**，
-- 也不建互评维度、量纲或参与率门槛（那是 P7，且量纲与维度由主办方在 `community` 配置里另行定义）。
--
-- 唯一新增事实：
--   ① 一条文字留言（作者、正文、所属队伍的作品、写留言时那一版正式收件、隐藏状态）；
--   ② 一次举报（谁在什么时候举报了哪条留言、可选说明）。
-- 三层门禁（赛事 workShowcase + 赛事 peerFeedback + 队伍本人选择公开）不落库：它是配置与既有
-- `ej_work_disclosures` 的只读派生，由服务层 `commentGate()` 判定，缺一即 403。
--
-- 本迁移只新增两张表、两个索引与两个触发器；**不改动任何既有表**，
-- 也不把留言并入任何汇总/名次/公布/导出——那些读取路径根本不引用这两张表。
--
-- 不可变边界：正文、作者、队伍、写留言时的那一版作品与重试标识不可改写；
-- 只允许 active -> hidden 且 revision 加一（同一条只能隐藏一次）。
-- 举报是 append-only 事实，没有 UPDATE/DELETE 入口。

-- 规划 34 C②「文字留言」（P5）：与数值互评（P7）**分列**的独立事实。
-- 本表只存纯文字：没有评分列、没有量纲、没有维度，也不参与任何汇总/名次/公布/导出。
-- 三层门禁缺一即 403（community.workShowcase + community.peerFeedback + 队伍本人的有效披露）由服务层判定；
-- 本表既不落"开关状态"，也不落"哪件作品被公开"（那是 ej_work_disclosures 的既有事实）。
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
