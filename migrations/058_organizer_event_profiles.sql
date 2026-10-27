-- 主办方赛事补充资料（2026-10-11，规划25 / P03）
--
-- 背景：自动发现的赛事卡片大量缺少选手关心的信息（运行库 15 场里只有 3 场有时间窗口证据），
-- 而只有主办方能给出权威答案。本表保存 HostedEvent 之外、选手关心的补充字段，
-- 让"待补字段"清单能把未知变成有出处的答案。
--
-- 边界（宪法 v1.15.0 原则 II）：
--  - 本表不替代 HostedEvent 的时间与规则字段；
--  - 抓取证据与主办方填写分别留存，冲突时由人决定，不自动覆盖；
--  - 清单是派生视图，不落完成百分比或勾选状态。
CREATE TABLE organizer_event_profiles (
  event_id text PRIMARY KEY,
  organization_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  updated_by text NOT NULL REFERENCES auth_users(id),
  updated_at timestamptz NOT NULL,
  FOREIGN KEY(event_id, organization_id) REFERENCES organizer_hosted_events(id, organization_id)
);
