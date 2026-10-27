-- 主办方认领已发现的赛事（2026-10-11，规划25 / P02）
--
-- 背景：公开赛事页的内容大量来自第三方目录与聚合站的自动发现，主办方本人往往不在场。
-- 认领让主办方把"抓到的这场比赛"挂到自己名下，用抓取结果作为预填草稿，避免从头录第二遍。
--
-- 安全底线（宪法 v1.15.0 原则 II）：
--  - 候选匹配只作提示，不产生任何权限或归属；
--  - 未通过归属核实前不得改写任何公开内容；
--  - 同一场自动发现赛事只能被认领一次；
--  - 认领不复制、不删除自动发现记录，主办方确认的值写入自己的赛事草稿与发布版本。
--
-- 本表不改 organizer_hosted_events，避免影响既有赛事查询与发布流程。
CREATE TABLE organizer_claim_requests (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizer_organizations(id),
  discovery_id text NOT NULL REFERENCES event_discovery_cards(id),
  source_host text NOT NULL CHECK (length(source_host) BETWEEN 1 AND 255),
  requested_by text NOT NULL REFERENCES auth_users(id),
  status text NOT NULL CHECK (status IN ('pending','approved','rejected','withdrawn')),
  -- 批准的认领挂接目标；认领只建立归属关系，预填值写入该赛事的草稿字段。
  hosted_event_id text,
  revision integer NOT NULL CHECK (revision > 0),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  reviewed_by text REFERENCES auth_users(id),
  reviewed_at timestamptz,
  UNIQUE(id, organization_id),
  FOREIGN KEY(hosted_event_id, organization_id) REFERENCES organizer_hosted_events(id, organization_id)
);
CREATE INDEX organizer_claim_requests_organization ON organizer_claim_requests(organization_id, created_at DESC);
CREATE INDEX organizer_claim_requests_review ON organizer_claim_requests(status, created_at);
-- 同一场发现只能被一个机构认领一次；被驳回或撤回后允许重新申请。
CREATE UNIQUE INDEX organizer_claim_requests_active_discovery ON organizer_claim_requests(discovery_id)
  WHERE status IN ('pending','approved');
