-- Suggestion only: root copies into a new incremental migration, never rewrites applied files.
CREATE TABLE event_official_links (
  hosted_event_id text PRIMARY KEY REFERENCES organizer_hosted_events(id),
  organization_id text NOT NULL REFERENCES organizer_organizations(id),
  hosted_published_revision integer NOT NULL CHECK (hosted_published_revision > 0),
  linked_event_id text NOT NULL,
  rules_version integer NOT NULL CHECK (rules_version > 0),
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('active','withdrawn')),
  document jsonb NOT NULL,
  updated_by text NOT NULL REFERENCES auth_users(id),
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (hosted_event_id,organization_id) REFERENCES organizer_hosted_events(id,organization_id),
  CHECK (jsonb_typeof(document) = 'object'),
  CHECK (document->>'hostedEventId' = hosted_event_id),
  CHECK (document->>'organizationId' = organization_id),
  CHECK (document->>'linkedEventId' = linked_event_id),
  CHECK ((document->>'hostedPublishedRevision')::integer = hosted_published_revision),
  CHECK ((document->>'rulesVersion')::integer = rules_version),
  CHECK ((document->>'revision')::integer = revision),
  CHECK (document->>'status' = status)
);
CREATE INDEX event_official_links_organization ON event_official_links(organization_id,hosted_event_id);
CREATE TABLE event_official_link_history (
  id text PRIMARY KEY,
  hosted_event_id text NOT NULL REFERENCES organizer_hosted_events(id),
  organization_id text NOT NULL REFERENCES organizer_organizations(id),
  revision integer NOT NULL CHECK (revision > 0),
  action text NOT NULL CHECK (action IN ('set','withdraw')),
  document jsonb NOT NULL,
  actor_user_id text NOT NULL REFERENCES auth_users(id),
  created_at timestamptz NOT NULL,
  FOREIGN KEY (hosted_event_id,organization_id) REFERENCES organizer_hosted_events(id,organization_id),
  UNIQUE (hosted_event_id,revision)
);
CREATE FUNCTION event_official_links_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'event official history is immutable'; END $$;
CREATE TRIGGER event_official_link_history_immutable BEFORE UPDATE OR DELETE ON event_official_link_history FOR EACH ROW EXECUTE FUNCTION event_official_links_immutable();
