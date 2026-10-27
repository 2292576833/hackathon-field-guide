-- 记录"昵称是否由用户自己改过"（2026-10-12）
--
-- 背景：观猹登录首次关联时要把观猹昵称作为**默认昵称**继承下来，但不得覆盖用户自己改过的名字。
-- 仅凭昵称取值无法可靠区分（注册默认值是「参赛新人」，用户也可能恰好取一样的名字），
-- 因此用一个显式标记：注册时为 false，用户在账号设置里改过昵称后为 true。
--
-- 回填规则：把"当前昵称既不等于注册默认值、也非空"的既有账号视为已自定义，避免被覆盖。
ALTER TABLE auth_users ADD COLUMN display_name_customized boolean NOT NULL DEFAULT false;
UPDATE auth_users SET display_name_customized = true
 WHERE btrim(display_name) <> '' AND display_name <> '参赛新人';
