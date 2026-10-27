CREATE TABLE server_role_assignment_audit (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT,
  added_role text NOT NULL CHECK (added_role IN ('admin','reviewer')),
  previous_roles text[] NOT NULL,
  new_roles text[] NOT NULL,
  authority text NOT NULL CHECK (authority='trusted_server_cli'),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
