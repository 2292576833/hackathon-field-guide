-- 074 · 工作人员受限邀请（P3 模块的根增量迁移）
--
-- 依据：规划 34 §1 A 与宪法 v1.23.0 原则 XIII「工作人员受限邀请（取代点开即授权）」。
-- 本迁移只新增一张表与两个索引：邀请链接单次使用、有有效期、可撤销、可绑定已验证邮箱；
-- 领取只写既有 organizer_staff_grants（不新增第二套授权事实），状态只落 open|claimed|revoked，
-- expired 由 expires_at 派生。
--
-- 与模块 `src/modules/organizer/migrations/002-staff-invitations.sql` 保持一致（由主会话编号并应用）。
CREATE TABLE organizer_staff_invitations (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizer_organizations(id),
 -- NULL = 本组织全部比赛；非 NULL = 只对这一场生效。
 event_id text,
 role text NOT NULL CHECK(role IN ('organization_admin','staff')),
 -- 与 organizer_staff_grants 同一套既有能力枚举；邀请不得引入自定义权限。
 capabilities text[] NOT NULL CHECK(capabilities <@ ARRAY['event_manage','registration_manage','teams_manage','communication_manage','schedule_manage','logistics_manage','judging_manage']::text[]),
 -- 只落 open/claimed/revoked；expired 由 expires_at 派生，不落库（避免状态漂移）。
 status text NOT NULL CHECK(status IN ('open','claimed','revoked')),
 -- sha256(token) 十六进制；原文 token 只在创建响应返回一次。
 token_hash text NOT NULL UNIQUE,
 -- 绑定邮箱（小写）或 NULL。领取账号的已验证邮箱必须与之一致。
 bound_email text,
 expires_at timestamptz NOT NULL,
 claimed_by_user_id text REFERENCES auth_users(id),
 claimed_at timestamptz,
 revoked_by_user_id text REFERENCES auth_users(id),
 revoked_at timestamptz,
 created_by_user_id text NOT NULL REFERENCES auth_users(id),
 created_at timestamptz NOT NULL,
 revision integer NOT NULL CHECK(revision > 0),
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
 FOREIGN KEY(event_id,organization_id) REFERENCES organizer_hosted_events(id,organization_id),
 -- 与既有 StaffGrant 相同的约束：机构管理员只能是机构范围。
 CHECK(role <> 'organization_admin' OR event_id IS NULL),
 -- 领取事实:领取人与时间只能随 claimed 一起存在，status 恢复 open 为非法。
 CHECK((status='claimed') = (claimed_at IS NOT NULL)),
 CHECK((status='claimed') = (claimed_by_user_id IS NOT NULL)),
 CHECK((status='revoked') = (revoked_at IS NOT NULL)),
 CHECK((status='revoked') = (revoked_by_user_id IS NOT NULL)),
 CHECK(bound_email IS NULL OR bound_email = lower(bound_email))
);
CREATE INDEX organizer_staff_invitations_organization ON organizer_staff_invitations(organization_id, created_at DESC);
CREATE INDEX organizer_staff_invitations_event ON organizer_staff_invitations(event_id) WHERE event_id IS NOT NULL;

