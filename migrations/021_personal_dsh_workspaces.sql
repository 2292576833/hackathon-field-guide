-- One durable website DSH workspace per verified account. Native child processes
-- remain isolated; only application-owned messages/artifacts are retained here.
CREATE TABLE personal_dsh_sessions (
 id text PRIMARY KEY, user_id text NOT NULL UNIQUE REFERENCES auth_users(id),
 active_job_id text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
INSERT INTO personal_dsh_sessions(id,user_id,created_at,updated_at)
 SELECT id,id,created_at,created_at FROM auth_users WHERE status='active'
 ON CONFLICT(user_id) DO NOTHING;
CREATE TABLE personal_dsh_messages (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 session_id text NOT NULL REFERENCES personal_dsh_sessions(id),
 project_id text, role text NOT NULL CHECK(role IN ('user','assistant')),
 content text NOT NULL CHECK(length(content)<=6000), created_at timestamptz NOT NULL
);
CREATE INDEX personal_dsh_messages_recent ON personal_dsh_messages(session_id,project_id,id DESC);
CREATE TABLE personal_ai_artifacts (
 id text PRIMARY KEY REFERENCES ai_execution_jobs(id),
 user_id text NOT NULL REFERENCES auth_users(id), session_id text NOT NULL REFERENCES personal_dsh_sessions(id),
 kind text NOT NULL CHECK(kind IN ('participation_plan','roadshow','ppt')),
 title text NOT NULL CHECK(length(title)<=200), data jsonb NOT NULL,
 created_at timestamptz NOT NULL
);
CREATE INDEX personal_ai_artifacts_owner ON personal_ai_artifacts(user_id,kind,created_at DESC,id);
CREATE TABLE personal_ai_requests (
 execution_id text PRIMARY KEY REFERENCES ai_execution_jobs(id),
 user_id text NOT NULL REFERENCES auth_users(id), request_hash text NOT NULL,
 created_at timestamptz NOT NULL
);
CREATE INDEX personal_ai_requests_hash ON personal_ai_requests(user_id,request_hash,created_at DESC);
