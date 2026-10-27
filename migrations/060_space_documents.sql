-- 空间文档（2026-10-12，规划27 第1期追加）
--
-- 背景：用户要求在团队空间里**直接写文档**。既有 `m07_documents` 只承载固定四种 kind
-- （复盘、经验卡、复用草稿、生成任务），不能写自由文档，因此新建本表，不改造既有表。
--
-- 语义（按"写在空间里"的最自然理解）：
--  - 团队共享：本空间活跃成员都能读；作者本人可改、可删；
--  - 纯人工写作，不接 AI 生成，不参与任务、检查、交付或阶段事实；
--  - revision 乐观并发，避免两人同时编辑互相覆盖；
--  - title/body 用列存放便于约束，structural 字段（id/authorId/revision/时间）与列一致。
CREATE TABLE space_documents (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  author_id text NOT NULL REFERENCES auth_users(id),
  title text NOT NULL CHECK (length(btrim(title)) > 0 AND length(title) <= 200),
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 20000),
  revision integer NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
-- 列表按空间读取，最近更新在前。
CREATE INDEX space_documents_project_idx ON space_documents (project_id, updated_at DESC);
