-- O03 proposal only. Root assigns an actual incremental migration number.
-- Only ec_ tables are touched; event/organization authorization is injected.
CREATE TABLE ec_schedule_state (
  organization_id text NOT NULL, event_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0), published_revision integer,
  document jsonb NOT NULL, updated_by text NOT NULL REFERENCES auth_users(id),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id,event_id)
);
CREATE TABLE ec_schedule_publications (
  organization_id text NOT NULL, event_id text NOT NULL, revision integer NOT NULL CHECK (revision > 0),
  document jsonb NOT NULL, published_by text NOT NULL REFERENCES auth_users(id),
  published_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id,event_id,revision),
  FOREIGN KEY (organization_id,event_id) REFERENCES ec_schedule_state(organization_id,event_id)
);
CREATE TABLE ec_schedule_import_previews (
  id text PRIMARY KEY, organization_id text NOT NULL, event_id text NOT NULL,
  actor_user_id text NOT NULL REFERENCES auth_users(id), expected_revision integer NOT NULL CHECK(expected_revision >= 0),
  document jsonb NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  confirmed_at timestamptz, confirmed_revision integer,
  CHECK ((confirmed_at IS NULL) = (confirmed_revision IS NULL))
);
CREATE INDEX ec_schedule_previews_scope ON ec_schedule_import_previews(organization_id,event_id,actor_user_id);
CREATE TABLE ec_icebreaker_activities (
  id text PRIMARY KEY, organization_id text NOT NULL, event_id text NOT NULL,
  revision integer NOT NULL CHECK(revision > 0), document jsonb NOT NULL,
  created_by text NOT NULL REFERENCES auth_users(id), created_at timestamptz NOT NULL,
  UNIQUE(organization_id,event_id,id)
);
CREATE INDEX ec_icebreaker_activity_scope ON ec_icebreaker_activities(organization_id,event_id);
CREATE TABLE ec_icebreaker_responses (
  organization_id text NOT NULL, event_id text NOT NULL, activity_id text NOT NULL,
  user_id text NOT NULL REFERENCES auth_users(id), choice text NOT NULL CHECK(choice IN ('join','decline')),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(organization_id,event_id,activity_id,user_id),
  FOREIGN KEY(organization_id,event_id,activity_id) REFERENCES ec_icebreaker_activities(organization_id,event_id,id)
);
CREATE TABLE ec_icebreaker_groups (
  id text PRIMARY KEY, organization_id text NOT NULL, event_id text NOT NULL, activity_id text NOT NULL,
  title text NOT NULL, revision integer NOT NULL CHECK(revision > 0),
  updated_by text NOT NULL REFERENCES auth_users(id), updated_at timestamptz NOT NULL,
  UNIQUE(organization_id,event_id,activity_id,title),
  UNIQUE(organization_id,event_id,activity_id,id),
  FOREIGN KEY(organization_id,event_id,activity_id) REFERENCES ec_icebreaker_activities(organization_id,event_id,id)
);
CREATE TABLE ec_icebreaker_group_members (
  organization_id text NOT NULL, event_id text NOT NULL, activity_id text NOT NULL, group_id text NOT NULL,
  user_id text NOT NULL REFERENCES auth_users(id),
  PRIMARY KEY(organization_id,event_id,activity_id,user_id),
  FOREIGN KEY(organization_id,event_id,activity_id,group_id) REFERENCES ec_icebreaker_groups(organization_id,event_id,activity_id,id)
);
CREATE TABLE ec_icebreaker_group_versions (
  organization_id text NOT NULL, event_id text NOT NULL, activity_id text NOT NULL, group_id text NOT NULL,
  revision integer NOT NULL CHECK(revision > 0), document jsonb NOT NULL,
  recorded_by text NOT NULL REFERENCES auth_users(id), recorded_at timestamptz NOT NULL,
  PRIMARY KEY(organization_id,event_id,activity_id,group_id,revision),
  FOREIGN KEY(organization_id,event_id,activity_id,group_id) REFERENCES ec_icebreaker_groups(organization_id,event_id,activity_id,id)
);
CREATE FUNCTION ec_schedule_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ec schedule and group history is immutable';
END;
$$;
CREATE TRIGGER ec_schedule_publications_immutable BEFORE UPDATE OR DELETE ON ec_schedule_publications
  FOR EACH ROW EXECUTE FUNCTION ec_schedule_history_immutable();
CREATE TRIGGER ec_icebreaker_group_versions_immutable BEFORE UPDATE OR DELETE ON ec_icebreaker_group_versions
  FOR EACH ROW EXECUTE FUNCTION ec_schedule_history_immutable();
