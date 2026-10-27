-- Module proposal only: root must assign the next real migration number.
CREATE TABLE ec_announcements (
  id text PRIMARY KEY, organization_id text NOT NULL, event_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0), published_revision integer,
  status text NOT NULL CHECK (status IN ('draft','published','withdrawn')),
  document jsonb NOT NULL, updated_by text NOT NULL REFERENCES auth_users(id)
);
CREATE INDEX ec_announcements_scope ON ec_announcements(organization_id,event_id);
CREATE TABLE ec_announcement_versions (
  announcement_id text NOT NULL REFERENCES ec_announcements(id), organization_id text NOT NULL,
  event_id text NOT NULL, revision integer NOT NULL, document jsonb NOT NULL,
  PRIMARY KEY(announcement_id,revision)
);
CREATE TABLE ec_announcement_reads (
  organization_id text NOT NULL, event_id text NOT NULL,
  announcement_id text NOT NULL REFERENCES ec_announcements(id), revision integer NOT NULL,
  user_id text NOT NULL REFERENCES auth_users(id), read_at timestamptz NOT NULL,
  PRIMARY KEY(announcement_id,revision,user_id),
  FOREIGN KEY(announcement_id,revision) REFERENCES ec_announcement_versions(announcement_id,revision)
);
CREATE TABLE ec_help_tickets (
  id text PRIMARY KEY, organization_id text NOT NULL, event_id text NOT NULL,
  user_id text NOT NULL REFERENCES auth_users(id), visibility text NOT NULL CHECK(visibility IN ('public','private')),
  status text NOT NULL CHECK(status IN ('open','in_progress','answered','closed')),
  revision integer NOT NULL CHECK(revision > 0), document jsonb NOT NULL,
  updated_by text NOT NULL REFERENCES auth_users(id)
);
CREATE INDEX ec_tickets_scope ON ec_help_tickets(organization_id,event_id,status);
CREATE TABLE ec_help_ticket_versions (
  ticket_id text NOT NULL REFERENCES ec_help_tickets(id), organization_id text NOT NULL,
  event_id text NOT NULL, revision integer NOT NULL, document jsonb NOT NULL,
  PRIMARY KEY(ticket_id,revision)
);
-- Public projections intentionally contain no owner or source-ticket identifier.
CREATE TABLE ec_public_faqs (
  id text PRIMARY KEY, organization_id text NOT NULL, event_id text NOT NULL,
  source_ticket_id text NOT NULL UNIQUE REFERENCES ec_help_tickets(id), revision integer NOT NULL,
  document jsonb NOT NULL
);
CREATE FUNCTION ec_communication_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ec communication history is immutable';
END;
$$;
CREATE TRIGGER ec_announcement_versions_immutable BEFORE UPDATE OR DELETE ON ec_announcement_versions
  FOR EACH ROW EXECUTE FUNCTION ec_communication_history_immutable();
CREATE TRIGGER ec_help_ticket_versions_immutable BEFORE UPDATE OR DELETE ON ec_help_ticket_versions
  FOR EACH ROW EXECUTE FUNCTION ec_communication_history_immutable();
