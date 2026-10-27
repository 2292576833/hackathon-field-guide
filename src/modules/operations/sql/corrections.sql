-- Suggested migration only. Includes public-content references, no project copies.
CREATE TABLE IF NOT EXISTS operations_corrections (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('received','triaging','confirmed','needs_more_info','dismissed','resolved')),
  updated_at timestamptz NOT NULL,
  original jsonb NOT NULL CHECK ((jsonb_typeof(original) = 'object') IS TRUE),
  state jsonb NOT NULL,
  CHECK ((jsonb_typeof(state) = 'object') IS TRUE),
  CHECK ((state->>'id' = id AND (state->>'revision')::integer = revision AND state->>'status' = status) IS TRUE)
);
CREATE INDEX IF NOT EXISTS operations_corrections_owner
  ON operations_corrections (owner_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS operations_corrections_queue
  ON operations_corrections (status, updated_at ASC, id ASC);
CREATE TABLE IF NOT EXISTS operations_correction_transitions (
  id text PRIMARY KEY,
  correction_id text NOT NULL REFERENCES operations_corrections(id),
  revision integer NOT NULL CHECK (revision > 1),
  actor_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK ((jsonb_typeof(payload) = 'object') IS TRUE),
  UNIQUE (correction_id, revision)
);
CREATE OR REPLACE FUNCTION operations_correction_original_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.original IS DISTINCT FROM OLD.original OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'original correction submission is immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS operations_correction_original_immutable_trigger ON operations_corrections;
CREATE TRIGGER operations_correction_original_immutable_trigger
BEFORE UPDATE ON operations_corrections FOR EACH ROW
EXECUTE FUNCTION operations_correction_original_immutable();
-- Runtime role gets SELECT/INSERT on transitions, no UPDATE/DELETE. Worker gets
-- no access here. Retention/deletion policy must be wired separately by admin.
-- Responses are station status records only; this migration sends no messages.
