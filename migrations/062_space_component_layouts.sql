-- 空间组件台布局（2026-10-12，规划27 追加 · 用户要求"所有组件都可拖动、隐藏、删除、折叠"）
--
-- 语义与边界：
--  - 只保存**布局偏好**：顺序、是否折叠、是否从首屏移除。不保存任何业务数据；
--  - 严格按 (project_id, user_id) 隔离：布局是每个人自己的，队友互不影响；
--  - "移除"（removed）只表示**不再显示在首屏**，组件承载的真实数据（待办、文档、任务）完全不受影响，
--    随时可以从"已移除的组件"里加回来；
--  - items 用 jsonb 数组保存，元素形如 {"id":"todos","collapsed":false,"removed":false}；
--    顺序即数组顺序；缺失的组件由客户端按默认顺序补齐。
CREATE TABLE space_component_layouts (
  project_id text NOT NULL,
  user_id text NOT NULL REFERENCES auth_users(id),
  revision integer NOT NULL CHECK (revision > 0),
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
