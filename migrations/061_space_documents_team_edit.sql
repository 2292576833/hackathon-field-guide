-- 空间文档共享给队友编辑（2026-10-12，规划27 第1期追加 · 用户确认方案 B）
--
-- 用户要求"所有组件都有一个标记，点击可以直接共享"，并确认共享后可编辑。
-- 边界（避免隐私泄露）：
--  - 共享是**作者主动动作**，默认关闭；不是一创建就人人可改；
--  - 作者可随时收回；收回后队友立即回到只读；
--  - shared_at 记录共享事实与时间，便于队友动态说明"谁共享了什么"；
--  - 共享只影响"谁能改这份文档"，不改变任何任务、检查、交付或阶段事实。
ALTER TABLE space_documents ADD COLUMN team_editable boolean NOT NULL DEFAULT false;
ALTER TABLE space_documents ADD COLUMN shared_at timestamptz;
ALTER TABLE space_documents ADD CONSTRAINT space_documents_shared_consistency
  CHECK ((team_editable AND shared_at IS NOT NULL) OR (NOT team_editable AND shared_at IS NULL));
