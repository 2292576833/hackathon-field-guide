-- 空间手动待办（2026-10-12，规划27 第1期）
--
-- 背景：待办清单的主体是**派生**的——"要我填/要我确认/要我做/要我读"四类，
-- 全部由既有事实（目标、时间、职责、赛道、规则、任务状态、检查记录）算出，
-- 不落库、不新增完成状态（宪法 v1.16.0 原则 X 第3、4条）。
--
-- 但用户明确要求待办清单"可以自己标记添加"：本人临时想到的事要能写进来。
-- 因此本表只服务于**本人手动添加**的那部分：
--  - 严格按 (project_id, user_id) 隔离，只有本人可读写，队友不可见；
--  - 必须带可见标题与明确的结束条件（本人标记完成即结束）；
--  - 不参与、不影响任何派生事实、任务状态、检查记录或项目阶段；
--  - completed_at 只表示"本人把这条私人待办标记完成"，不是任何交付或验收结论。
CREATE TABLE space_manual_todos (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  user_id text NOT NULL REFERENCES auth_users(id),
  title text NOT NULL CHECK (length(btrim(title)) > 0 AND length(title) <= 200),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  status text NOT NULL CHECK (status IN ('open','done')),
  completed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  CHECK ((status = 'done') = (completed_at IS NOT NULL))
);
-- 只按本人 + 项目读取；列表按未完成优先、再按创建时间。
CREATE INDEX space_manual_todos_owner_idx ON space_manual_todos (project_id, user_id, status, created_at DESC);
