-- 观猹登录：让"待关联"期间不丢失观猹昵称与头像地址（2026-10-12）
--
-- 背景：观猹回调与"确认关联"之间隔着一次邮箱验证，用户可能过几分钟才回来点确认。
-- 069 之前 guancha_pending_links 只存 issuer/subject，观猹 userinfo 返回的 nickname 与
-- avatar_url 会在这一步丢失，导致"继承观猹头像与昵称"无法实现。
--
-- 两列都可空（观猹在没有头像/昵称时本来就不返回对应字段）。
-- avatar_url 只是**候选下载地址**，字节校验在服务端下载时进行，绝不直接展示第三方地址。
ALTER TABLE guancha_pending_links ADD COLUMN avatar_url text CHECK (avatar_url IS NULL OR length(avatar_url) <= 2048);
ALTER TABLE guancha_pending_links ADD COLUMN display_name text CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 60);
