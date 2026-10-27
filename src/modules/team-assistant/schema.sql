-- R03 migration proposal only. The root coordinator chooses the numbered migration
-- and applies it after auth_users and projects_project exist.
-- Authorization remains in the service/root transaction; these keys only isolate storage.
CREATE TABLE team_assistant_conversations (
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT,
  project_id text NOT NULL REFERENCES projects_project(id) ON DELETE RESTRICT,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  active_request_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE team_assistant_requests (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  user_id text NOT NULL,
  project_id text NOT NULL,
  request_id text NOT NULL,
  request_hash text NOT NULL,
  message text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','succeeded','failed','unknown')),
  response_id text,
  error_code text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at >= created_at),
  PRIMARY KEY (user_id, project_id, request_id),
  FOREIGN KEY (user_id, project_id)
    REFERENCES team_assistant_conversations(user_id, project_id) ON DELETE RESTRICT
);
CREATE INDEX team_assistant_requests_latest
  ON team_assistant_requests(user_id, project_id, sequence DESC);
CREATE INDEX team_assistant_requests_uncertain_hash
  ON team_assistant_requests(user_id, project_id, request_hash, sequence DESC)
  WHERE status IN ('running','unknown');

CREATE TABLE team_assistant_messages (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  user_id text NOT NULL,
  project_id text NOT NULL,
  request_id text NOT NULL,
  id text NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL,
  provider text CHECK (provider = 'dsh'),
  links jsonb NOT NULL CHECK (jsonb_typeof(links) = 'array'),
  coverage jsonb CHECK (coverage IS NULL OR jsonb_typeof(coverage) = 'object'),
  PRIMARY KEY (user_id, project_id, id),
  UNIQUE (user_id, project_id, request_id, role),
  CHECK ((role = 'user' AND provider IS NULL) OR (role = 'assistant' AND provider IS NOT NULL AND provider = 'dsh')),
  FOREIGN KEY (user_id, project_id, request_id)
    REFERENCES team_assistant_requests(user_id, project_id, request_id) ON DELETE RESTRICT
);
CREATE INDEX team_assistant_messages_history
  ON team_assistant_messages(user_id, project_id, sequence DESC);

-- Clearing a conversation only DELETEs the scoped messages. Do not delete requests
-- or cascade conversation deletion: unknown paid calls must survive chat clearing.
