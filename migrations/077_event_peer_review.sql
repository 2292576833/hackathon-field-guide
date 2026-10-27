-- 077 · 作品数值互评（P7 模块的根增量迁移）
--
-- 依据：规划 34 §3 C② 与宪法 v1.23.0 原则 XIII「作品公开与点评（分列、不计入名次）」。
-- 本迁移只新增本模块自己的两张表：数值互评（一队一件作品一名评分者一条有效记录）与举报（只增不改）。
-- 互评**与文字留言、评审分三者分列**；MUST NOT 并入名次/公布/对外导出，评分期评委不可见。
--
-- 与模块 `src/modules/event-peer-review/migrations/001-event-peer-review.sql` 保持一致（由主会话编号并应用）。
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

