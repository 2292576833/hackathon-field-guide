-- Module proposal only. The coordinating session assigns an incremental root migration.
-- event/organization/project identities are checked through injected ports, never other modules' tables.
CREATE TABLE event_registration_event_state (
  event_id text PRIMARY KEY,
  organization_id text NOT NULL,
  UNIQUE(event_id, organization_id)
);

CREATE TABLE event_registration_forms (
  event_id text NOT NULL REFERENCES event_registration_event_state(event_id),
  revision integer NOT NULL CHECK(revision > 0),
  published_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY(event_id,revision),
  CHECK(jsonb_typeof(data)='object' AND data ?& ARRAY['eventId','revision','publishedAt']),
  CHECK((data->>'eventId'=event_id AND (data->>'revision')::integer=revision AND (data->>'publishedAt')::timestamptz=published_at) IS TRUE)
);

CREATE TABLE event_registration_registrations (
  event_id text NOT NULL,
  id text NOT NULL,
  organization_id text NOT NULL,
  user_id text NOT NULL REFERENCES auth_users(id),
  revision integer NOT NULL CHECK(revision > 0),
  status text NOT NULL CHECK(status IN ('draft','pending','approved','rejected','withdrawn')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY(event_id,id),
  UNIQUE(event_id,user_id),
  -- Own registrations use a single cursor across the requesting account's competitions.
  UNIQUE(id),
  FOREIGN KEY(event_id,organization_id) REFERENCES event_registration_event_state(event_id,organization_id),
  CHECK(jsonb_typeof(data)='object' AND data ?& ARRAY['eventId','id','organizationId','userId','revision','status','createdAt','updatedAt']),
  CHECK((data->>'eventId'=event_id AND data->>'id'=id AND data->>'organizationId'=organization_id AND data->>'userId'=user_id AND (data->>'revision')::integer=revision AND data->>'status'=status AND (data->>'createdAt')::timestamptz=created_at AND (data->>'updatedAt')::timestamptz=updated_at) IS TRUE)
);
CREATE INDEX event_registration_registrations_status ON event_registration_registrations(event_id,status,id);
CREATE INDEX event_registration_registrations_user ON event_registration_registrations(user_id,id);

CREATE TABLE event_registration_teams (
  event_id text NOT NULL,
  id text NOT NULL,
  organization_id text NOT NULL,
  captain_user_id text NOT NULL REFERENCES auth_users(id),
  revision integer NOT NULL CHECK(revision > 0),
  status text NOT NULL CHECK(status IN ('forming','locked','withdrawn')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY(event_id,id),
  FOREIGN KEY(event_id,organization_id) REFERENCES event_registration_event_state(event_id,organization_id),
  CHECK(jsonb_typeof(data)='object' AND data ?& ARRAY['eventId','id','organizationId','captainUserId','revision','status','createdAt','updatedAt']),
  CHECK((data->>'eventId'=event_id AND data->>'id'=id AND data->>'organizationId'=organization_id AND data->>'captainUserId'=captain_user_id AND (data->>'revision')::integer=revision AND data->>'status'=status AND (data->>'createdAt')::timestamptz=created_at AND (data->>'updatedAt')::timestamptz=updated_at) IS TRUE)
);
CREATE INDEX event_registration_teams_status ON event_registration_teams(event_id,status,id);

-- The only source of real accepted roster membership; cached JSON arrays do not reserve seats.
CREATE TABLE event_registration_members (
  event_id text NOT NULL,
  team_id text NOT NULL,
  user_id text NOT NULL REFERENCES auth_users(id),
  accepted_at timestamptz NOT NULL,
  left_at timestamptz,
  PRIMARY KEY(event_id,team_id,user_id),
  FOREIGN KEY(event_id,team_id) REFERENCES event_registration_teams(event_id,id),
  FOREIGN KEY(event_id,user_id) REFERENCES event_registration_registrations(event_id,user_id),
  CHECK(left_at IS NULL OR left_at >= accepted_at)
);
CREATE UNIQUE INDEX event_registration_one_active_team ON event_registration_members(event_id,user_id) WHERE left_at IS NULL;
CREATE INDEX event_registration_active_roster ON event_registration_members(event_id,team_id,user_id) WHERE left_at IS NULL;

CREATE TABLE event_registration_join_requests (
  event_id text NOT NULL,
  id text NOT NULL,
  team_id text NOT NULL,
  user_id text NOT NULL REFERENCES auth_users(id),
  revision integer NOT NULL CHECK(revision > 0),
  status text NOT NULL CHECK(status IN ('pending','accepted','rejected','cancelled')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY(event_id,id),
  UNIQUE(event_id,team_id,user_id),
  FOREIGN KEY(event_id,team_id) REFERENCES event_registration_teams(event_id,id),
  FOREIGN KEY(event_id,user_id) REFERENCES event_registration_registrations(event_id,user_id),
  CHECK(jsonb_typeof(data)='object' AND data ?& ARRAY['eventId','id','teamId','userId','revision','status','createdAt','updatedAt']),
  CHECK((data->>'eventId'=event_id AND data->>'id'=id AND data->>'teamId'=team_id AND data->>'userId'=user_id AND (data->>'revision')::integer=revision AND data->>'status'=status AND (data->>'createdAt')::timestamptz=created_at AND (data->>'updatedAt')::timestamptz=updated_at) IS TRUE)
);
CREATE INDEX event_registration_requests_owner ON event_registration_join_requests(event_id,user_id,id);
CREATE INDEX event_registration_requests_pending ON event_registration_join_requests(event_id,team_id,status,id);

CREATE TABLE event_registration_project_links (
  event_id text NOT NULL,
  id text NOT NULL,
  team_id text NOT NULL,
  project_id text NOT NULL,
  requested_by_user_id text NOT NULL REFERENCES auth_users(id),
  revision integer NOT NULL CHECK(revision > 0),
  status text NOT NULL CHECK(status IN ('pending','confirmed','cancelled')),
  created_at timestamptz NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY(event_id,id),
  FOREIGN KEY(event_id,team_id) REFERENCES event_registration_teams(event_id,id),
  CHECK(jsonb_typeof(data)='object' AND data ?& ARRAY['eventId','id','teamId','projectId','requestedByUserId','revision','status','createdAt']),
  CHECK((data->>'eventId'=event_id AND data->>'id'=id AND data->>'teamId'=team_id AND data->>'projectId'=project_id AND data->>'requestedByUserId'=requested_by_user_id AND (data->>'revision')::integer=revision AND data->>'status'=status AND (data->>'createdAt')::timestamptz=created_at) IS TRUE)
);
CREATE INDEX event_registration_links_latest ON event_registration_project_links(event_id,team_id,created_at DESC,id DESC);

-- A staff proposal grants neither membership nor project permission. Its original data is immutable.
CREATE TABLE event_registration_team_suggestions (
  event_id text NOT NULL REFERENCES event_registration_event_state(event_id),
  id text NOT NULL,
  captain_user_id text NOT NULL REFERENCES auth_users(id),
  created_by_user_id text NOT NULL REFERENCES auth_users(id),
  team_id text,
  data jsonb NOT NULL,
  PRIMARY KEY(event_id,id),
  FOREIGN KEY(event_id,team_id) REFERENCES event_registration_teams(event_id,id),
  CHECK(jsonb_typeof(data)='object' AND data ?& ARRAY['eventId','id','captainUserId','createdByUserId','memberUserIds']),
  CHECK((data->>'eventId'=event_id AND data->>'id'=id AND data->>'captainUserId'=captain_user_id AND data->>'createdByUserId'=created_by_user_id AND jsonb_typeof(data->'memberUserIds')='array') IS TRUE)
);
CREATE INDEX event_registration_suggestions_members ON event_registration_team_suggestions USING gin((data->'memberUserIds'));

CREATE TABLE event_registration_history (
  event_id text NOT NULL REFERENCES event_registration_event_state(event_id),
  kind text NOT NULL CHECK(kind IN ('registration','team','join','link')),
  id text NOT NULL,
  revision integer NOT NULL CHECK(revision > 0),
  actor_user_id text NOT NULL REFERENCES auth_users(id),
  recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  data jsonb NOT NULL,
  PRIMARY KEY(event_id,kind,id,revision),
  CHECK(jsonb_typeof(data)='object' AND data ?& ARRAY['eventId','id','revision']),
  CHECK((data->>'eventId'=event_id AND data->>'id'=id AND (data->>'revision')::integer=revision) IS TRUE)
);

CREATE TABLE event_registration_receipts (
  event_id text NOT NULL REFERENCES event_registration_event_state(event_id),
  user_id text NOT NULL REFERENCES auth_users(id),
  operation text NOT NULL CHECK(length(operation) BETWEEN 1 AND 500),
  key text NOT NULL CHECK(length(key) BETWEEN 1 AND 200),
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(event_id,user_id,operation,key)
);

-- Append-only forms, audit versions and idempotent results cannot be rewritten through SQL.
CREATE FUNCTION event_registration_reject_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'event registration immutable record cannot be changed' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER event_registration_forms_immutable BEFORE UPDATE OR DELETE ON event_registration_forms FOR EACH ROW EXECUTE FUNCTION event_registration_reject_immutable_change();
CREATE TRIGGER event_registration_history_immutable BEFORE UPDATE OR DELETE ON event_registration_history FOR EACH ROW EXECUTE FUNCTION event_registration_reject_immutable_change();
CREATE TRIGGER event_registration_receipts_immutable BEFORE UPDATE OR DELETE ON event_registration_receipts FOR EACH ROW EXECUTE FUNCTION event_registration_reject_immutable_change();
CREATE TRIGGER event_registration_suggestions_immutable BEFORE UPDATE OF data,captain_user_id,created_by_user_id,event_id,id ON event_registration_team_suggestions FOR EACH ROW EXECUTE FUNCTION event_registration_reject_immutable_change();
CREATE TRIGGER event_registration_suggestions_no_delete BEFORE DELETE ON event_registration_team_suggestions FOR EACH ROW EXECUTE FUNCTION event_registration_reject_immutable_change();
