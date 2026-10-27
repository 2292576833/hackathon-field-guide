-- 空间画布摆放（2026-10-12，规划27 追加 · 用户确认形态"组件箱 + 自由画布"）
--
-- 形态：左侧组件箱，用户把组件拖进画布自由摆放；每张卡片能折叠、共享、删除（从画布移除）。
--
-- 语义与边界：
--  - 只保存**摆放偏好**：哪些组件、放在哪、是否折叠。**不保存任何业务数据**；
--  - "删除"只是不再出现在画布上，待办/文档/任务等真实数据完全不受影响，可随时从组件箱加回；
--  - 严格按 (project_id, user_id) 隔离：画布是每个人自己的，队友互不影响；
--  - items 为 jsonb 数组，元素形如 {"instanceId":"todos-1","kind":"todos","x":24,"y":24,"collapsed":false}，
--    顺序即创建顺序；同一个组件可以放多份（不同 instanceId）。
CREATE TABLE space_canvas_items (
  project_id text NOT NULL,
  user_id text NOT NULL REFERENCES auth_users(id),
  revision integer NOT NULL CHECK (revision > 0),
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
