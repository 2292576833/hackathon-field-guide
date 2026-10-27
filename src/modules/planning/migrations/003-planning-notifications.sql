-- Proposal only: coordinator incorporates a new root migration, never rewrites applied SQL.
-- This consumer owns receipts; planning_outbox remains intact for other consumers.
CREATE TABLE planning_notification_consumptions (
  event_id text PRIMARY KEY REFERENCES planning_outbox(event_id),
  project_id text NOT NULL,
  consumed_at timestamptz NOT NULL
);
CREATE TABLE planning_notifications (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  cause text NOT NULL CHECK (cause IN ('deadline_risk','owner_changed','availability_changed','rules_changed','input_changed','deliverable_review','task_blocked','acceptance_correction_requested')),
  source_revision text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  resolved_at timestamptz,
  body jsonb NOT NULL CHECK (jsonb_typeof(body)='object'),
  UNIQUE(project_id,cause,source_revision)
);
CREATE TABLE planning_notification_recipients (
  notification_id text NOT NULL REFERENCES planning_notifications(id),
  user_id text NOT NULL,
  membership_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  read_at timestamptz,
  dismissed_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY(notification_id,user_id)
);
CREATE INDEX planning_notifications_project ON planning_notifications(project_id,updated_at DESC,id DESC);
CREATE INDEX planning_notification_recipients_own ON planning_notification_recipients(user_id,notification_id) WHERE revoked_at IS NULL AND dismissed_at IS NULL;
