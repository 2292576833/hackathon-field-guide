-- Root-owned review bridge. Rule/source/evidence content stays in immutable M03 snapshots.
CREATE TABLE integration_event_candidates (
  id text PRIMARY KEY,
  event_id text COLLATE "C" NOT NULL REFERENCES m03_events(id),
  revision integer NOT NULL CHECK(revision > 0),
  rules_version integer NOT NULL CHECK(rules_version > 0),
  content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  schema_version text NOT NULL,
  created_by text NOT NULL REFERENCES auth_users(id),
  last_modified_by text NOT NULL REFERENCES auth_users(id),
  origin text NOT NULL CHECK(origin IN ('manual','worker')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  published_version integer,
  FOREIGN KEY(event_id,rules_version) REFERENCES m03_rule_versions(event_id,version),
  CHECK(published_version IS NULL OR published_version=rules_version),
  UNIQUE(event_id,rules_version)
);
CREATE TABLE integration_event_candidate_revisions (
  candidate_id text NOT NULL REFERENCES integration_event_candidates(id),
  revision integer NOT NULL CHECK(revision > 0),
  event_id text COLLATE "C" NOT NULL,
  rules_version integer NOT NULL,
  content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  schema_version text NOT NULL,
  created_by text NOT NULL REFERENCES auth_users(id),
  last_modified_by text NOT NULL REFERENCES auth_users(id),
  origin text NOT NULL CHECK(origin IN ('manual','worker')),
  changed_at timestamptz NOT NULL,
  PRIMARY KEY(candidate_id,revision),
  FOREIGN KEY(event_id,rules_version) REFERENCES m03_rule_versions(event_id,version)
);
-- Publication references, not duplicated content; accepted correction targets may be formerly public.
CREATE TABLE integration_public_versions (
  kind text NOT NULL CHECK(kind IN ('event','resource')),
  entity_id text NOT NULL,
  version integer NOT NULL CHECK(version > 0),
  published_at timestamptz NOT NULL,
  review_id text,
  PRIMARY KEY(kind,entity_id,version)
);
INSERT INTO integration_public_versions(kind,entity_id,version,published_at)
SELECT 'event',aggregate_id,version,min(occurred_at) FROM m03_events_outbox
WHERE type IN ('EventPublished','EventRulesChanged') GROUP BY aggregate_id,version
ON CONFLICT DO NOTHING;
INSERT INTO integration_public_versions(kind,entity_id,version,published_at)
SELECT 'event',id,(body->>'publishedVersion')::integer,COALESCE((body->>'lastVerifiedAt')::timestamptz,now())
FROM m03_events WHERE body->>'publishedVersion' IS NOT NULL
ON CONFLICT DO NOTHING;
INSERT INTO integration_public_versions(kind,entity_id,version,published_at,review_id)
SELECT DISTINCT ON(resource_id,(public_document->>'version')::integer)
  'resource',resource_id,(public_document->>'version')::integer,
  COALESCE((public_document->>'publishedAt')::timestamptz,changed_at),public_document->>'reviewId'
FROM resource_revisions WHERE public_document->>'publicationStatus' IN ('published','withdrawn')
ORDER BY resource_id,(public_document->>'version')::integer,revision
ON CONFLICT DO NOTHING;
CREATE FUNCTION integration_candidate_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.origin IS DISTINCT FROM OLD.origin THEN
    RAISE EXCEPTION 'Candidate identity and origin are immutable';
  END IF;
  IF OLD.published_version IS NOT NULL THEN
    RAISE EXCEPTION 'Published candidates are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integration_candidate_identity_guard BEFORE UPDATE ON integration_event_candidates
FOR EACH ROW EXECUTE FUNCTION integration_candidate_identity_immutable();
CREATE FUNCTION integration_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Integration history is append-only'; END $$;
CREATE TRIGGER integration_candidate_history_guard BEFORE UPDATE OR DELETE ON integration_event_candidate_revisions
FOR EACH ROW EXECUTE FUNCTION integration_history_immutable();
CREATE TRIGGER integration_public_history_guard BEFORE UPDATE OR DELETE ON integration_public_versions
FOR EACH ROW EXECUTE FUNCTION integration_history_immutable();
