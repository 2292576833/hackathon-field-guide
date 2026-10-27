-- Suggestion only. Root applies NEW incremental migration after reviewing query plans.
-- No new audit store: these indexes serve existing immutable M08 audit facts.
CREATE INDEX IF NOT EXISTS operations_execution_audit_page
  ON operations_execution_audit (occurred_at DESC, (('execution:' || id) COLLATE "C") DESC);
CREATE INDEX IF NOT EXISTS operations_event_review_audit_page
  ON operations_event_review_audit (occurred_at DESC, (('event_review:' || id) COLLATE "C") DESC);
CREATE INDEX IF NOT EXISTS operations_resource_review_audit_page
  ON operations_resource_review_audit (occurred_at DESC, (('resource_review:' || id) COLLATE "C") DESC);
CREATE INDEX IF NOT EXISTS operations_correction_transitions_audit_page
  ON operations_correction_transitions (occurred_at DESC, (('correction:' || id) COLLATE "C") DESC);
CREATE INDEX IF NOT EXISTS operations_discovery_control_audit_page
  ON operations_discovery_control_audit (occurred_at DESC, (('discovery_control:' || id::text) COLLATE "C") DESC);
-- The statement timeout and execution plan belong to root's database deployment.
-- Keep existing runtime append-only privileges; no UPDATE/DELETE or worker access.
