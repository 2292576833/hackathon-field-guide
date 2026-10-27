-- 082 · 主办方专属页的**图片资产**（规划35 多模态方案 C：图片只存档，不生成、不识别内容）
-- 宪法 v1.24.0 XIV：图片是主办方自己的素材，平台只存与取，不用于训练。
-- 只收三种位图（PNG/JPEG/WebP）；不收 SVG（可带脚本），不存外链（避免盗链与失效）。

CREATE TABLE organizer_page_assets (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizer_organizations(id),
 event_id text NOT NULL,
 mime_type text NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/webp')),
 bytes bytea NOT NULL CHECK(octet_length(bytes) > 0),
 -- 同赛事内按内容去重：同一张图重复上传不产生第二份字节。
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 created_by text NOT NULL REFERENCES auth_users(id),
 created_at timestamptz NOT NULL,
 UNIQUE(event_id, sha256),
 FOREIGN KEY(event_id, organization_id) REFERENCES organizer_hosted_events(id, organization_id)
);

CREATE INDEX organizer_page_assets_event ON organizer_page_assets(event_id, created_at DESC);
