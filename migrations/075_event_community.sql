-- 075 · 选手社区：连接、私信、屏蔽与举报（P6 模块的根增量迁移）
--
-- 依据：规划 34 §4 D 与宪法 v1.23.0 原则 XIII「选手社区（名录、连接、私信）」。
-- 四张表各管一件事实：连接（双向同意）、私信（只在连接内、可撤回）、屏蔽、举报（只记事实不裁决）。
-- 默认全关；赛事级开关来自共享 EventCommunityConfig，随正式发布版本冻结。
-- 消息内容 MUST NOT 进入任何模型训练；本模块不调用任何 AI。
--
-- 与模块 `src/modules/event-community/migrations/001-event-community.sql` 保持一致（由主会话编号并应用）。
CREATE TABLE evc_connections (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  pair_key text NOT NULL CHECK (length(pair_key) BETWEEN 3 AND 400),
  requester_user_id text NOT NULL REFERENCES auth_users(id),
  addressee_user_id text NOT NULL REFERENCES auth_users(id),
  status text NOT NULL CHECK (status IN ('pending','accepted','rejected','cancelled')),
  revision integer NOT NULL CHECK (revision > 0),
  requested_at timestamptz NOT NULL,
  responded_at timestamptz,
  decided_by_user_id text REFERENCES auth_users(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  UNIQUE (organization_id, event_id, id),
  UNIQUE (organization_id, event_id, requester_user_id, idempotency_key),
  FOREIGN KEY (event_id, organization_id) REFERENCES organizer_hosted_events(id, organization_id),
  CHECK (requester_user_id <> addressee_user_id),
  CHECK ((status = 'pending') = (responded_at IS NULL)),
  CHECK ((status = 'pending') = (decided_by_user_id IS NULL)),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'pairKey') IS NOT DISTINCT FROM pair_key),
  CHECK ((document->>'requesterUserId') IS NOT DISTINCT FROM requester_user_id),
  CHECK ((document->>'addresseeUserId') IS NOT DISTINCT FROM addressee_user_id),
  CHECK ((document->>'status') IS NOT DISTINCT FROM status),
  CHECK ((document->>'revision')::integer IS NOT DISTINCT FROM revision),
  CHECK ((document->>'idempotencyKey') IS NOT DISTINCT FROM idempotency_key)
);
CREATE INDEX evc_connections_scope_time ON evc_connections(organization_id, event_id, requested_at, id);
-- 同一对账号在本场最多一条 pending 或 accepted；被拒绝/取消的行作为历史保留，因此可以重新发起（受冷却约束）。
CREATE UNIQUE INDEX evc_connections_open_pair ON evc_connections(organization_id, event_id, pair_key) WHERE status IN ('pending','accepted');
CREATE INDEX evc_connections_rejection ON evc_connections(organization_id, event_id, pair_key, responded_at DESC) WHERE status = 'rejected';
CREATE INDEX evc_connections_pending_user ON evc_connections(organization_id, event_id, requester_user_id, addressee_user_id) WHERE status = 'pending';

CREATE FUNCTION evc_protect_connection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.event_id IS DISTINCT FROM OLD.event_id
    OR NEW.pair_key IS DISTINCT FROM OLD.pair_key
    OR NEW.requester_user_id IS DISTINCT FROM OLD.requester_user_id
    OR NEW.addressee_user_id IS DISTINCT FROM OLD.addressee_user_id
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
  THEN
    RAISE EXCEPTION 'event community connection scope, direction and request key are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'event community connection revision must increase by one' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('accepted','rejected','cancelled') THEN
    RAISE EXCEPTION 'event community connection can only move from pending to accepted, rejected or cancelled' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'accepted' AND NEW.decided_by_user_id IS DISTINCT FROM OLD.addressee_user_id THEN
    RAISE EXCEPTION 'event community connection acceptance must come from the addressee' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'rejected' AND NEW.decided_by_user_id NOT IN (OLD.requester_user_id, OLD.addressee_user_id) THEN
    RAISE EXCEPTION 'event community connection rejection must come from one of the two accounts' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'cancelled' AND NEW.decided_by_user_id IS DISTINCT FROM OLD.requester_user_id THEN
    RAISE EXCEPTION 'event community connection cancellation must come from the requester' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER evc_connections_identity_frozen BEFORE UPDATE ON evc_connections
  FOR EACH ROW EXECUTE FUNCTION evc_protect_connection();

/* ---------- 私信 ---------- */

CREATE TABLE evc_direct_messages (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  connection_id text NOT NULL,
  sender_user_id text NOT NULL REFERENCES auth_users(id),
  recipient_user_id text NOT NULL REFERENCES auth_users(id),
  content text,
  status text NOT NULL CHECK (status IN ('active','withdrawn','purged')),
  revision integer NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL,
  withdrawn_at timestamptz,
  purged_at timestamptz,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  UNIQUE (organization_id, event_id, id),
  UNIQUE (organization_id, event_id, sender_user_id, idempotency_key),
  FOREIGN KEY (event_id, organization_id) REFERENCES organizer_hosted_events(id, organization_id),
  FOREIGN KEY (organization_id, event_id, connection_id) REFERENCES evc_connections(organization_id, event_id, id),
  CHECK (sender_user_id <> recipient_user_id),
  CHECK ((status = 'active') = (content IS NOT NULL)),
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  CHECK ((status = 'purged') = (purged_at IS NOT NULL)),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'connectionId') IS NOT DISTINCT FROM connection_id),
  CHECK ((document->>'senderUserId') IS NOT DISTINCT FROM sender_user_id),
  CHECK ((document->>'recipientUserId') IS NOT DISTINCT FROM recipient_user_id),
  CHECK ((document->>'content') IS NOT DISTINCT FROM content),
  CHECK ((document->>'status') IS NOT DISTINCT FROM status),
  CHECK ((document->>'revision')::integer IS NOT DISTINCT FROM revision),
  CHECK ((document->>'idempotencyKey') IS NOT DISTINCT FROM idempotency_key)
);
CREATE INDEX evc_direct_messages_thread ON evc_direct_messages(organization_id, event_id, connection_id, created_at, id);
CREATE INDEX evc_direct_messages_sender_time ON evc_direct_messages(organization_id, event_id, sender_user_id, created_at);
CREATE INDEX evc_direct_messages_purge ON evc_direct_messages(organization_id, event_id, created_at, id) WHERE status = 'active';

CREATE FUNCTION evc_protect_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.event_id IS DISTINCT FROM OLD.event_id
    OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.sender_user_id IS DISTINCT FROM OLD.sender_user_id
    OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
  THEN
    RAISE EXCEPTION 'event community message scope, participants, time and request key are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'event community message revision must increase by one' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'active' OR NEW.status NOT IN ('withdrawn','purged') THEN
    RAISE EXCEPTION 'event community message can only move from active to withdrawn or purged' USING ERRCODE = '23514';
  END IF;
  IF NEW.content IS DISTINCT FROM OLD.content AND NEW.content IS NOT NULL THEN
    RAISE EXCEPTION 'withdrawn or purged event community message content must be cleared' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER evc_direct_messages_identity_frozen BEFORE UPDATE ON evc_direct_messages
  FOR EACH ROW EXECUTE FUNCTION evc_protect_message();

/* ---------- 屏蔽 ---------- */

CREATE TABLE evc_blocks (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  blocker_user_id text NOT NULL REFERENCES auth_users(id),
  blocked_user_id text NOT NULL REFERENCES auth_users(id),
  created_at timestamptz NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  UNIQUE (organization_id, event_id, id),
  UNIQUE (organization_id, event_id, blocker_user_id, blocked_user_id),
  FOREIGN KEY (event_id, organization_id) REFERENCES organizer_hosted_events(id, organization_id),
  CHECK (blocker_user_id <> blocked_user_id),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'blockerUserId') IS NOT DISTINCT FROM blocker_user_id),
  CHECK ((document->>'blockedUserId') IS NOT DISTINCT FROM blocked_user_id)
);
CREATE INDEX evc_blocks_scope_time ON evc_blocks(organization_id, event_id, created_at, id);

CREATE FUNCTION evc_protect_block() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'event community block is immutable; delete and re-create instead' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER evc_blocks_immutable BEFORE UPDATE ON evc_blocks
  FOR EACH ROW EXECUTE FUNCTION evc_protect_block();

/* ---------- 举报（只记录事实，不记录裁决） ---------- */

CREATE TABLE evc_reports (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  reporter_user_id text NOT NULL REFERENCES auth_users(id),
  reported_user_id text NOT NULL REFERENCES auth_users(id),
  connection_id text,
  reason text NOT NULL CHECK (reason IN ('harassment','spam','contact_touting','impersonation','other')),
  detail text NOT NULL CHECK (length(detail) <= 1000),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'array'),
  status text NOT NULL CHECK (status = 'open'),
  created_at timestamptz NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  UNIQUE (organization_id, event_id, id),
  UNIQUE (organization_id, event_id, reporter_user_id, idempotency_key),
  FOREIGN KEY (event_id, organization_id) REFERENCES organizer_hosted_events(id, organization_id),
  FOREIGN KEY (organization_id, event_id, connection_id) REFERENCES evc_connections(organization_id, event_id, id),
  CHECK (reporter_user_id <> reported_user_id),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'reporterUserId') IS NOT DISTINCT FROM reporter_user_id),
  CHECK ((document->>'reportedUserId') IS NOT DISTINCT FROM reported_user_id),
  CHECK ((document->>'connectionId') IS NOT DISTINCT FROM connection_id),
  CHECK ((document->>'reason') IS NOT DISTINCT FROM reason),
  CHECK ((document->>'detail') IS NOT DISTINCT FROM detail),
  CHECK ((document->>'status') IS NOT DISTINCT FROM status),
  CHECK ((document->>'idempotencyKey') IS NOT DISTINCT FROM idempotency_key)
);
CREATE INDEX evc_reports_scope_time ON evc_reports(organization_id, event_id, created_at, id);

CREATE FUNCTION evc_protect_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'event community report is an immutable recorded fact' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER evc_reports_immutable BEFORE UPDATE ON evc_reports
  FOR EACH ROW EXECUTE FUNCTION evc_protect_report();

