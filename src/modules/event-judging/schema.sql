-- O04 migration suggestion only; the coordinator assigns an incremental root migration.
-- JSON documents match model.ts. Indexed identity/status/revision columns are checked
-- against the document. All cross-entity references include organization and event.
-- No table from another module is queried or changed; auth_users is the identity FK.

CREATE TABLE ej_event_locks (
  organization_id text NOT NULL,
  event_id text NOT NULL,
  PRIMARY KEY (organization_id, event_id)
);

CREATE TABLE ej_intake_receipts (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  team_id text NOT NULL,
  author_user_id text NOT NULL REFERENCES auth_users(id),
  version integer NOT NULL CHECK (version > 0),
  receipt_number text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  submitted_at timestamptz NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  UNIQUE (organization_id, event_id, id),
  UNIQUE (organization_id, event_id, author_user_id, idempotency_key),
  UNIQUE (organization_id, event_id, team_id, version),
  UNIQUE (organization_id, event_id, receipt_number),
  FOREIGN KEY (organization_id, event_id) REFERENCES ej_event_locks(organization_id, event_id),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'teamId') IS NOT DISTINCT FROM team_id),
  CHECK ((document->>'authorUserId') IS NOT DISTINCT FROM author_user_id),
  CHECK ((document->>'version')::integer IS NOT DISTINCT FROM version),
  CHECK ((document->>'receiptNumber') IS NOT DISTINCT FROM receipt_number),
  CHECK ((document->>'idempotencyKey') IS NOT DISTINCT FROM idempotency_key)
);
CREATE INDEX ej_intake_receipts_scope_time ON ej_intake_receipts(organization_id, event_id, submitted_at, id);

CREATE TABLE ej_judging_rounds (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('setup','open','locked','published')),
  created_at timestamptz NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  UNIQUE (organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id) REFERENCES ej_event_locks(organization_id, event_id),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'revision')::integer IS NOT DISTINCT FROM revision),
  CHECK ((document->>'status') IS NOT DISTINCT FROM status)
);
CREATE INDEX ej_judging_rounds_scope_time ON ej_judging_rounds(organization_id, event_id, created_at, id);

CREATE TABLE ej_judge_assignments (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  round_id text NOT NULL,
  snapshot_id text NOT NULL,
  judge_user_id text NOT NULL REFERENCES auth_users(id),
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('active','needs_review','recused','revoked')),
  declaration text NOT NULL CHECK (declaration IN ('unconfirmed','clear','conflict')),
  created_at timestamptz NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  UNIQUE (organization_id, event_id, id),
  UNIQUE (organization_id, event_id, round_id, snapshot_id, judge_user_id),
  FOREIGN KEY (organization_id, event_id, round_id) REFERENCES ej_judging_rounds(organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id, snapshot_id) REFERENCES ej_intake_receipts(organization_id, event_id, id),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'roundId') IS NOT DISTINCT FROM round_id),
  CHECK ((document->>'snapshotId') IS NOT DISTINCT FROM snapshot_id),
  CHECK ((document->>'judgeUserId') IS NOT DISTINCT FROM judge_user_id),
  CHECK ((document->>'revision')::integer IS NOT DISTINCT FROM revision),
  CHECK ((document->>'status') IS NOT DISTINCT FROM status),
  CHECK ((document->>'declaration') IS NOT DISTINCT FROM declaration)
);
CREATE INDEX ej_judge_assignments_scope_judge ON ej_judge_assignments(organization_id, event_id, judge_user_id, status);

CREATE TABLE ej_manual_scores (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  assignment_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  state text NOT NULL CHECK (state IN ('draft','submitted')),
  updated_at timestamptz NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  UNIQUE (organization_id, event_id, assignment_id),
  FOREIGN KEY (organization_id, event_id, assignment_id) REFERENCES ej_judge_assignments(organization_id, event_id, id),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'assignmentId') IS NOT DISTINCT FROM assignment_id),
  CHECK ((document->>'revision')::integer IS NOT DISTINCT FROM revision),
  CHECK ((document->>'state') IS NOT DISTINCT FROM state)
);
CREATE INDEX ej_manual_scores_scope_time ON ej_manual_scores(organization_id, event_id, updated_at, id);

CREATE TABLE ej_published_results (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  round_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  visibility text NOT NULL CHECK (visibility IN ('public','participants')),
  published_at timestamptz NOT NULL,
  published_by text NOT NULL REFERENCES auth_users(id),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  UNIQUE (organization_id, event_id, id),
  UNIQUE (organization_id, event_id, version),
  FOREIGN KEY (organization_id, event_id, round_id) REFERENCES ej_judging_rounds(organization_id, event_id, id),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'roundId') IS NOT DISTINCT FROM round_id),
  CHECK ((document->>'version')::integer IS NOT DISTINCT FROM version),
  CHECK ((document->>'visibility') IS NOT DISTINCT FROM visibility),
  CHECK ((document->>'publishedBy') IS NOT DISTINCT FROM published_by)
);

-- 参赛者申诉：公布之后的新事实。状态与裁决可变，但申诉人写下的原始理由、范围与时间不可改写。
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
-- 一条队伍对同一版公布结果只能有一条有效申诉；撤回后可以重新提交。
CREATE UNIQUE INDEX ej_result_appeals_one_open ON ej_result_appeals(organization_id, event_id, published_result_id, team_id) WHERE status <> 'withdrawn';

CREATE TABLE ej_judging_audits (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  actor_user_id text NOT NULL REFERENCES auth_users(id),
  action text NOT NULL,
  subject_id text NOT NULL,
  created_at timestamptz NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  FOREIGN KEY (organization_id, event_id) REFERENCES ej_event_locks(organization_id, event_id),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'actorUserId') IS NOT DISTINCT FROM actor_user_id),
  CHECK ((document->>'action') IS NOT DISTINCT FROM action),
  CHECK ((document->>'subjectId') IS NOT DISTINCT FROM subject_id)
);
CREATE INDEX ej_judging_audits_scope_subject ON ej_judging_audits(organization_id, event_id, subject_id, created_at, id);

-- Frozen materials and publication/audit versions cannot be overwritten or deleted.
-- Withdrawal only changes the mutable round's publishedResultId, with a new audit.
CREATE FUNCTION ej_reject_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'O04 formal receipt, published result and audit history are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER ej_intake_receipts_immutable BEFORE UPDATE OR DELETE ON ej_intake_receipts
  FOR EACH ROW EXECUTE FUNCTION ej_reject_history_change();
CREATE TRIGGER ej_published_results_immutable BEFORE UPDATE OR DELETE ON ej_published_results
  FOR EACH ROW EXECUTE FUNCTION ej_reject_history_change();
CREATE TRIGGER ej_judging_audits_immutable BEFORE UPDATE OR DELETE ON ej_judging_audits
  FOR EACH ROW EXECUTE FUNCTION ej_reject_history_change();

-- Once started, criteria and the selected receipt set stay fixed even on reopen.
CREATE FUNCTION ej_protect_round_config() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'setup' AND (
    NEW.document->'config' IS DISTINCT FROM OLD.document->'config' OR
    NEW.document->'snapshotIds' IS DISTINCT FROM OLD.document->'snapshotIds' OR
    NEW.status = 'setup'
  ) THEN
    RAISE EXCEPTION 'O04 started judging criteria and receipt selection are frozen' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'O04 judging round revision must increase by one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ej_judging_rounds_config_frozen BEFORE UPDATE ON ej_judging_rounds
  FOR EACH ROW EXECUTE FUNCTION ej_protect_round_config();

-- 申诉只允许状态与裁决变化：范围、申诉人原始理由、时间与重试标识保持不可改写，版本必须递增。
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
-- 规划 34 C①「作品展示（队伍可选公开）」：本模块**唯一新增事实**。
-- 队伍本人对本场作品的公开范围选择（private 默认 / participants / public）+ 逐项字段选择。
-- 赛事级开关 community.workShowcase 关闭时，本表既不可写也不可读（服务层 403）。
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

