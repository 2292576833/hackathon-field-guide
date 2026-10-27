-- 084 · AI 工作台：已归档的会话（点「新会话」时把当前对话存成一条，可回看）
CREATE TABLE ai_console_threads (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  messages jsonb NOT NULL CHECK (jsonb_typeof(messages) = 'array'),
  created_at timestamptz NOT NULL
);
CREATE INDEX ai_console_threads_owner ON ai_console_threads(user_id, created_at DESC);
