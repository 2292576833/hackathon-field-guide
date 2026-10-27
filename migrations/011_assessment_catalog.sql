-- M04 additive migration proposal. Apply only after 001-assessments.sql.
-- The coordinating session owns actual migration execution and role grants.
-- Catalog content is public; reviewer identifiers and review notes are privileged.

CREATE TABLE assessments_catalog_reviews (
  question_set_id text PRIMARY KEY REFERENCES assessments_question_sets(id),
  revision integer NOT NULL CHECK (revision >= 1),
  content_fingerprint text NOT NULL CHECK (content_fingerprint ~ '^[0-9a-f]{64}$'),
  seeded_by text NOT NULL CHECK (length(btrim(seeded_by)) > 0),
  seeded_at timestamptz NOT NULL,
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  published_by text,
  published_at timestamptz,
  publication_note text,
  retired_by text,
  retired_at timestamptz,
  retirement_note text,
  CHECK ((reviewed_by IS NULL AND reviewed_at IS NULL AND review_note IS NULL)
    OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND review_note IS NOT NULL AND length(btrim(reviewed_by)) > 0 AND length(btrim(review_note)) BETWEEN 1 AND 5000)),
  CHECK ((published_by IS NULL AND published_at IS NULL AND publication_note IS NULL)
    OR (published_by IS NOT NULL AND published_at IS NOT NULL AND publication_note IS NOT NULL AND length(btrim(published_by)) > 0 AND length(btrim(publication_note)) BETWEEN 1 AND 5000)),
  CHECK ((retired_by IS NULL AND retired_at IS NULL AND retirement_note IS NULL)
    OR (retired_by IS NOT NULL AND retired_at IS NOT NULL AND retirement_note IS NOT NULL AND length(btrim(retired_by)) > 0 AND length(btrim(retirement_note)) BETWEEN 1 AND 5000)),
  CHECK (reviewed_at IS NULL OR reviewed_at >= seeded_at),
  CHECK (published_at IS NULL OR reviewed_at IS NOT NULL AND published_at >= reviewed_at),
  CHECK (retired_at IS NULL OR published_at IS NOT NULL AND retired_at >= published_at)
);
COMMENT ON TABLE assessments_catalog_reviews IS 'Privileged M04 catalog lifecycle metadata. Seeding is draft import, not review or publication; CAS revision and fixed content fingerprint bind each human action to one immutable question/rubric pair.';
COMMENT ON COLUMN assessments_catalog_reviews.content_fingerprint IS 'SHA-256 over canonical question content (ignoring lifecycle status) and fixed rubric; prevents publication of content changed after review.';
COMMENT ON COLUMN assessments_catalog_reviews.review_note IS 'Human review explanation; review does not establish scientific calibration or measured ability.';

CREATE TABLE assessments_catalog_audit (
  event_id text PRIMARY KEY,
  question_set_id text NOT NULL REFERENCES assessments_catalog_reviews(question_set_id),
  revision integer NOT NULL CHECK (revision >= 1),
  action text NOT NULL CHECK (action IN ('seeded', 'reviewed', 'published', 'retired')),
  actor_id text NOT NULL CHECK (length(btrim(actor_id)) > 0),
  previous_status text CHECK (previous_status IN ('draft', 'reviewed', 'published', 'retired')),
  next_status text NOT NULL CHECK (next_status IN ('draft', 'reviewed', 'published', 'retired')),
  occurred_at timestamptz NOT NULL,
  note text NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 5000),
  content_fingerprint text NOT NULL CHECK (content_fingerprint ~ '^[0-9a-f]{64}$'),
  UNIQUE (question_set_id, revision),
  CHECK ((action = 'seeded' AND previous_status IS NULL AND next_status = 'draft')
    OR (action = 'reviewed' AND previous_status IS NOT NULL AND previous_status = 'draft' AND next_status = 'reviewed')
    OR (action = 'published' AND previous_status IS NOT NULL AND previous_status = 'reviewed' AND next_status = 'published')
    OR (action = 'retired' AND previous_status IS NOT NULL AND previous_status = 'published' AND next_status = 'retired'))
);
COMMENT ON TABLE assessments_catalog_audit IS 'Privileged append-only catalog actor/revision/action history, written in the same transaction as lifecycle status; contains no personal assessment responses.';
CREATE INDEX assessments_catalog_audit_order ON assessments_catalog_audit(question_set_id, revision);
CREATE TRIGGER assessments_catalog_audit_immutable BEFORE UPDATE OR DELETE ON assessments_catalog_audit
  FOR EACH ROW EXECUTE FUNCTION assessments_reject_immutable_mutation();

CREATE FUNCTION assessments_guard_catalog_review_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'M04 catalog review history cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.question_set_id IS DISTINCT FROM OLD.question_set_id
    OR NEW.content_fingerprint IS DISTINCT FROM OLD.content_fingerprint
    OR NEW.seeded_by IS DISTINCT FROM OLD.seeded_by OR NEW.seeded_at IS DISTINCT FROM OLD.seeded_at
    OR NEW.revision <> OLD.revision + 1
    OR (OLD.reviewed_at IS NOT NULL AND ROW(NEW.reviewed_by, NEW.reviewed_at, NEW.review_note) IS DISTINCT FROM ROW(OLD.reviewed_by, OLD.reviewed_at, OLD.review_note))
    OR (OLD.published_at IS NOT NULL AND ROW(NEW.published_by, NEW.published_at, NEW.publication_note) IS DISTINCT FROM ROW(OLD.published_by, OLD.published_at, OLD.publication_note))
    OR (OLD.retired_at IS NOT NULL AND ROW(NEW.retired_by, NEW.retired_at, NEW.retirement_note) IS DISTINCT FROM ROW(OLD.retired_by, OLD.retired_at, OLD.retirement_note)) THEN
    RAISE EXCEPTION 'M04 catalog review metadata requires one new lifecycle revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assessments_catalog_review_metadata_guard BEFORE UPDATE OR DELETE ON assessments_catalog_reviews
  FOR EACH ROW EXECUTE FUNCTION assessments_guard_catalog_review_metadata();
