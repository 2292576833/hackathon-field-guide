-- 主办方邮箱查询限流（2026-10-11 全面检查加固）
--
-- 背景：`organizer/{eventId}/account-lookup` 允许本场工作人员按邮箱反查本站账号，
-- 响应可区分"已注册"与"未注册"，构成注册状态枚举面。此前该入口无任何频率限制与审计。
--
-- 本表只保存限流计数，不保存被查询的邮箱明文。
CREATE TABLE organizer_lookup_limits (
  organization_id text NOT NULL REFERENCES organizer_organizations(id),
  event_id text NOT NULL,
  actor_user_id text NOT NULL REFERENCES auth_users(id),
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts >= 0),
  last_attempt_at timestamptz,
  PRIMARY KEY (event_id, actor_user_id),
  FOREIGN KEY(event_id, organization_id) REFERENCES organizer_hosted_events(id,organization_id)
);
