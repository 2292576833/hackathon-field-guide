-- Per-account first-login guide progress; GET never initializes state.
CREATE TABLE user_onboarding (
  user_id text PRIMARY KEY REFERENCES auth_users(id),
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 60),
  step_index integer NOT NULL CHECK (step_index BETWEEN 0 AND 5),
  completed_at timestamptz,
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL,
  CONSTRAINT user_onboarding_completed_last_step CHECK (completed_at IS NULL OR step_index=5)
);
