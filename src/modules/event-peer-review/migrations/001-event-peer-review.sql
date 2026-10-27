-- 001 . 数值互评（event-peer-review 模块的迁移建议）
--
-- 本文件不是已部署迁移：由主会话分配递增编号（最新为 072，建议 073）写入根 migrations/ 后执行。
-- 风格参考 migrations/071_result_appeals.sql 与 072_event_closure.sql：JSONB document + 索引化身份列 +
-- 文档一致性 CHECK + 不可变触发器 + 部分唯一索引。
--
-- 为什么是独立模块、独立表（规划 34 把它和作品展示放在一起，本条是**有意的偏离**，理由如下）：
--   宪法 XIII 要求互评"MUST NOT 并入名次、公布或对外导出"且"评分期间评委不可见"。
--   把互评放在 src/modules/event-judging/ 时，这条约束只能靠"不要写错"的人为纪律维持；
--   放在独立模块后，结构上就不存在任何通往 event-judging 的 aggregate()/results/results-export/名次的写路径，
--   也天然没有评委侧入口。代价是 root 需要注入一个只读来源端口（见交付 NEEDS_INTERFACE）。
--
-- 本模块只新增这两张表，不改任何既有表。
-- 不可变边界：
--   * epr_peer_reviews 的身份列（赛事/作品/队伍/评分者/量纲/维度/分值/提交时间/重试标识）不可改写；
--     修改分值只能新增一条 active 行并把旧行标为 superseded（旧行 revision 不变）；
--     撤回只允许 active -> withdrawn 且 revision 加一；历史行全部保留。
--   * epr_review_reports 只允许 INSERT：举报只记录事实，不裁决、不改分数。

CREATE TABLE epr_peer_reviews (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  snapshot_id text NOT NULL,
  team_id text NOT NULL,
  reviewer_user_id text NOT NULL REFERENCES auth_users(id),
  scale text NOT NULL CHECK (scale IN ('1-5','0-10','yes-no')),
  status text NOT NULL CHECK (status IN ('active','withdrawn','superseded')),
  revision integer NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  withdrawn_at timestamptz,
  superseded_at timestamptz,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  UNIQUE (organization_id, event_id, id),
  UNIQUE (organization_id, event_id, reviewer_user_id, idempotency_key),
  FOREIGN KEY (event_id, organization_id) REFERENCES organizer_hosted_events(id, organization_id),
  FOREIGN KEY (event_id, team_id) REFERENCES event_registration_teams(event_id, id),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'snapshotId') IS NOT DISTINCT FROM snapshot_id),
  CHECK ((document->>'teamId') IS NOT DISTINCT FROM team_id),
  CHECK ((document->>'reviewerUserId') IS NOT DISTINCT FROM reviewer_user_id),
  CHECK ((document->>'scale') IS NOT DISTINCT FROM scale),
  CHECK ((document->>'status') IS NOT DISTINCT FROM status),
  CHECK ((document->>'revision')::integer IS NOT DISTINCT FROM revision),
  CHECK ((document->>'idempotencyKey') IS NOT DISTINCT FROM idempotency_key),
  CHECK (jsonb_typeof(document->'dimensions') = 'array'),
  CHECK (jsonb_typeof(document->'values') = 'array'),
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  CHECK ((status = 'superseded') = (superseded_at IS NOT NULL)),
  CHECK (withdrawn_at IS NULL OR superseded_at IS NULL)
);
CREATE INDEX epr_peer_reviews_scope_work ON epr_peer_reviews(organization_id, event_id, snapshot_id, id);
-- 一队一件作品一个评分者一条**有效**记录（active）；被取代或被撤回后可以再写入新的一条。
CREATE UNIQUE INDEX epr_peer_reviews_one_active ON epr_peer_reviews(organization_id, event_id, snapshot_id, reviewer_user_id) WHERE status = 'active';

CREATE FUNCTION epr_protect_peer_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.event_id IS DISTINCT FROM OLD.event_id
    OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id
    OR NEW.team_id IS DISTINCT FROM OLD.team_id
    OR NEW.reviewer_user_id IS DISTINCT FROM OLD.reviewer_user_id
    OR NEW.scale IS DISTINCT FROM OLD.scale
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.document->'dimensions' IS DISTINCT FROM OLD.document->'dimensions'
    OR NEW.document->'values' IS DISTINCT FROM OLD.document->'values'
  THEN
    RAISE EXCEPTION 'event peer review scope, reviewer, scale, dimensions and values are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'active' OR NEW.status NOT IN ('withdrawn','superseded') THEN
    RAISE EXCEPTION 'event peer review can only move from active to withdrawn or superseded' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'withdrawn' AND NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'event peer review withdrawal revision must increase by one' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'superseded' AND NEW.revision <> OLD.revision THEN
    RAISE EXCEPTION 'event peer review superseded row keeps its revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER epr_peer_reviews_frozen BEFORE UPDATE ON epr_peer_reviews
  FOR EACH ROW EXECUTE FUNCTION epr_protect_peer_review();

CREATE TABLE epr_review_reports (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  review_id text NOT NULL,
  snapshot_id text NOT NULL,
  team_id text NOT NULL,
  reporter_user_id text NOT NULL REFERENCES auth_users(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  UNIQUE (organization_id, event_id, review_id, reporter_user_id),
  FOREIGN KEY (event_id, organization_id) REFERENCES organizer_hosted_events(id, organization_id),
  FOREIGN KEY (review_id) REFERENCES epr_peer_reviews(id),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'reviewId') IS NOT DISTINCT FROM review_id),
  CHECK ((document->>'snapshotId') IS NOT DISTINCT FROM snapshot_id),
  CHECK ((document->>'teamId') IS NOT DISTINCT FROM team_id),
  CHECK ((document->>'reporterUserId') IS NOT DISTINCT FROM reporter_user_id),
  CHECK ((document->>'reason') IS NOT DISTINCT FROM reason),
  CHECK (jsonb_typeof(document->'values') = 'array')
);
CREATE INDEX epr_review_reports_scope ON epr_review_reports(organization_id, event_id, review_id, id);

CREATE FUNCTION epr_protect_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'event peer review reports are append-only facts' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER epr_review_reports_frozen BEFORE UPDATE OR DELETE ON epr_review_reports
  FOR EACH ROW EXECUTE FUNCTION epr_protect_report();
