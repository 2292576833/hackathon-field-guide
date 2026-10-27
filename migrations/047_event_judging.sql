-- O04 migration suggestion only; the coordinator assigns an incremental root migration.
-- JSON documents match model.ts. Indexed identity/status/revision columns are checked
-- against the document. All cross-entity references include organization and event.
-- No table from another module is queried or changed; auth_users is the identity FK.

CREATE TABLE ej_event_locks (
  organization_id text NOT NULL,
  event_id text NOT NULL,
  PRIMARY KEY (organization_id, event_id)
);

CREATE TABLE ej_intake_receipts (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  team_id text NOT NULL,
  author_user_id text NOT NULL REFERENCES auth_users(id),
  version integer NOT NULL CHECK (version > 0),
  receipt_number text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  submitted_at timestamptz NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  UNIQUE (organization_id, event_id, id),
  UNIQUE (organization_id, event_id, author_user_id, idempotency_key),
  UNIQUE (organization_id, event_id, team_id, version),
  UNIQUE (organization_id, event_id, receipt_number),
  FOREIGN KEY (organization_id, event_id) REFERENCES ej_event_locks(organization_id, event_id),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'teamId') IS NOT DISTINCT FROM team_id),
  CHECK ((document->>'authorUserId') IS NOT DISTINCT FROM author_user_id),
  CHECK ((document->>'version')::integer IS NOT DISTINCT FROM version),
  CHECK ((document->>'receiptNumber') IS NOT DISTINCT FROM receipt_number),
  CHECK ((document->>'idempotencyKey') IS NOT DISTINCT FROM idempotency_key)
);
CREATE INDEX ej_intake_receipts_scope_time ON ej_intake_receipts(organization_id, event_id, submitted_at, id);

CREATE TABLE ej_judging_rounds (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('setup','open','locked','published')),
  created_at timestamptz NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  UNIQUE (organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id) REFERENCES ej_event_locks(organization_id, event_id),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'revision')::integer IS NOT DISTINCT FROM revision),
  CHECK ((document->>'status') IS NOT DISTINCT FROM status)
);
CREATE INDEX ej_judging_rounds_scope_time ON ej_judging_rounds(organization_id, event_id, created_at, id);

CREATE TABLE ej_judge_assignments (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  round_id text NOT NULL,
  snapshot_id text NOT NULL,
  judge_user_id text NOT NULL REFERENCES auth_users(id),
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('active','needs_review','recused','revoked')),
  declaration text NOT NULL CHECK (declaration IN ('unconfirmed','clear','conflict')),
  created_at timestamptz NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  UNIQUE (organization_id, event_id, id),
  UNIQUE (organization_id, event_id, round_id, snapshot_id, judge_user_id),
  FOREIGN KEY (organization_id, event_id, round_id) REFERENCES ej_judging_rounds(organization_id, event_id, id),
  FOREIGN KEY (organization_id, event_id, snapshot_id) REFERENCES ej_intake_receipts(organization_id, event_id, id),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'roundId') IS NOT DISTINCT FROM round_id),
  CHECK ((document->>'snapshotId') IS NOT DISTINCT FROM snapshot_id),
  CHECK ((document->>'judgeUserId') IS NOT DISTINCT FROM judge_user_id),
  CHECK ((document->>'revision')::integer IS NOT DISTINCT FROM revision),
  CHECK ((document->>'status') IS NOT DISTINCT FROM status),
  CHECK ((document->>'declaration') IS NOT DISTINCT FROM declaration)
);
CREATE INDEX ej_judge_assignments_scope_judge ON ej_judge_assignments(organization_id, event_id, judge_user_id, status);

CREATE TABLE ej_manual_scores (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  assignment_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  state text NOT NULL CHECK (state IN ('draft','submitted')),
  updated_at timestamptz NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  UNIQUE (organization_id, event_id, assignment_id),
  FOREIGN KEY (organization_id, event_id, assignment_id) REFERENCES ej_judge_assignments(organization_id, event_id, id),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'assignmentId') IS NOT DISTINCT FROM assignment_id),
  CHECK ((document->>'revision')::integer IS NOT DISTINCT FROM revision),
  CHECK ((document->>'state') IS NOT DISTINCT FROM state)
);
CREATE INDEX ej_manual_scores_scope_time ON ej_manual_scores(organization_id, event_id, updated_at, id);

CREATE TABLE ej_published_results (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  round_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  visibility text NOT NULL CHECK (visibility IN ('public','participants')),
  published_at timestamptz NOT NULL,
  published_by text NOT NULL REFERENCES auth_users(id),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  UNIQUE (organization_id, event_id, id),
  UNIQUE (organization_id, event_id, version),
  FOREIGN KEY (organization_id, event_id, round_id) REFERENCES ej_judging_rounds(organization_id, event_id, id),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'roundId') IS NOT DISTINCT FROM round_id),
  CHECK ((document->>'version')::integer IS NOT DISTINCT FROM version),
  CHECK ((document->>'visibility') IS NOT DISTINCT FROM visibility),
  CHECK ((document->>'publishedBy') IS NOT DISTINCT FROM published_by)
);

CREATE TABLE ej_judging_audits (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  actor_user_id text NOT NULL REFERENCES auth_users(id),
  action text NOT NULL,
  subject_id text NOT NULL,
  created_at timestamptz NOT NULL,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  FOREIGN KEY (organization_id, event_id) REFERENCES ej_event_locks(organization_id, event_id),
  CHECK ((document->>'id') IS NOT DISTINCT FROM id),
  CHECK ((document->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document->>'eventId') IS NOT DISTINCT FROM event_id),
  CHECK ((document->>'actorUserId') IS NOT DISTINCT FROM actor_user_id),
  CHECK ((document->>'action') IS NOT DISTINCT FROM action),
  CHECK ((document->>'subjectId') IS NOT DISTINCT FROM subject_id)
);
CREATE INDEX ej_judging_audits_scope_subject ON ej_judging_audits(organization_id, event_id, subject_id, created_at, id);

-- Frozen materials and publication/audit versions cannot be overwritten or deleted.
-- Withdrawal only changes the mutable round's publishedResultId, with a new audit.
CREATE FUNCTION ej_reject_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'O04 formal receipt, published result and audit history are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER ej_intake_receipts_immutable BEFORE UPDATE OR DELETE ON ej_intake_receipts
  FOR EACH ROW EXECUTE FUNCTION ej_reject_history_change();
CREATE TRIGGER ej_published_results_immutable BEFORE UPDATE OR DELETE ON ej_published_results
  FOR EACH ROW EXECUTE FUNCTION ej_reject_history_change();
CREATE TRIGGER ej_judging_audits_immutable BEFORE UPDATE OR DELETE ON ej_judging_audits
  FOR EACH ROW EXECUTE FUNCTION ej_reject_history_change();

-- Once started, criteria and the selected receipt set stay fixed even on reopen.
CREATE FUNCTION ej_protect_round_config() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'setup' AND (
    NEW.document->'config' IS DISTINCT FROM OLD.document->'config' OR
    NEW.document->'snapshotIds' IS DISTINCT FROM OLD.document->'snapshotIds' OR
    NEW.status = 'setup'
  ) THEN
    RAISE EXCEPTION 'O04 started judging criteria and receipt selection are frozen' USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'O04 judging round revision must increase by one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ej_judging_rounds_config_frozen BEFORE UPDATE ON ej_judging_rounds
  FOR EACH ROW EXECUTE FUNCTION ej_protect_round_config();
