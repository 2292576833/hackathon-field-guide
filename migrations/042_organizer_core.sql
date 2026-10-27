-- O01 migration proposal only. Root numbers and executes the actual migration.
CREATE TABLE organizer_organizations (
 id text PRIMARY KEY,
 owner_user_id text NOT NULL REFERENCES auth_users(id),
 status text NOT NULL CHECK(status IN ('pending','approved','rejected','suspended')),
 revision integer NOT NULL CHECK(revision > 0),
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object')
);
CREATE TABLE organizer_applications (
 id text PRIMARY KEY,
 organization_id text NOT NULL UNIQUE REFERENCES organizer_organizations(id),
 applicant_user_id text NOT NULL REFERENCES auth_users(id),
 status text NOT NULL CHECK(status IN ('pending','approved','rejected','suspended')),
 revision integer NOT NULL CHECK(revision > 0),
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object')
);
CREATE INDEX organizer_applications_applicant ON organizer_applications(applicant_user_id);
CREATE TABLE organizer_hosted_events (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizer_organizations(id),
 status text NOT NULL CHECK(status IN ('draft','published','ended','archived')),
 revision integer NOT NULL CHECK(revision > 0),
 published_revision integer CHECK(published_revision > 0),
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
 UNIQUE(id,organization_id)
);
CREATE INDEX organizer_events_organization ON organizer_hosted_events(organization_id);
CREATE TABLE organizer_staff_grants (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizer_organizations(id),
 event_id text,
 user_id text NOT NULL REFERENCES auth_users(id),
 role text NOT NULL CHECK(role IN ('organization_admin','staff')),
 capabilities text[] NOT NULL CHECK(capabilities <@ ARRAY['event_manage','registration_manage','teams_manage','communication_manage','schedule_manage','logistics_manage','judging_manage']::text[]),
 status text NOT NULL CHECK(status IN ('active','revoked')),
 revision integer NOT NULL CHECK(revision > 0),
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
 FOREIGN KEY(event_id,organization_id) REFERENCES organizer_hosted_events(id,organization_id),
 CHECK(role <> 'organization_admin' OR event_id IS NULL)
);
CREATE UNIQUE INDEX organizer_active_org_grants ON organizer_staff_grants(organization_id,user_id) WHERE status='active' AND event_id IS NULL;
CREATE UNIQUE INDEX organizer_active_event_grants ON organizer_staff_grants(organization_id,event_id,user_id) WHERE status='active' AND event_id IS NOT NULL;
CREATE INDEX organizer_grants_user ON organizer_staff_grants(user_id,organization_id);
CREATE TABLE organizer_event_publications (
 event_id text NOT NULL REFERENCES organizer_hosted_events(id),
 version integer NOT NULL CHECK(version > 0),
 source_revision integer NOT NULL CHECK(source_revision > 0),
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
 PRIMARY KEY(event_id,version), UNIQUE(event_id,source_revision)
);
-- INSERT only in the adapter; never rewrite a previously published snapshot.
CREATE TABLE organizer_publication_changes (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizer_organizations(id),
 event_id text NOT NULL,
 version integer NOT NULL,
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
 FOREIGN KEY(event_id,organization_id) REFERENCES organizer_hosted_events(id,organization_id),
 FOREIGN KEY(event_id,version) REFERENCES organizer_event_publications(event_id,version),
 UNIQUE(event_id,version)
);
CREATE TABLE organizer_audit_events (
 id text PRIMARY KEY,
 organization_id text NOT NULL REFERENCES organizer_organizations(id),
 event_id text,
 actor_user_id text NOT NULL REFERENCES auth_users(id),
 action text NOT NULL,
 entity_id text NOT NULL,
 revision integer NOT NULL,
 created_at timestamptz NOT NULL,
 FOREIGN KEY(event_id,organization_id) REFERENCES organizer_hosted_events(id,organization_id)
);
CREATE FUNCTION organizer_reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Organizer history is immutable; append a new version' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER organizer_publication_immutable BEFORE UPDATE OR DELETE ON organizer_event_publications
 FOR EACH ROW EXECUTE FUNCTION organizer_reject_history_mutation();
CREATE TRIGGER organizer_publication_change_immutable BEFORE UPDATE OR DELETE ON organizer_publication_changes
 FOR EACH ROW EXECUTE FUNCTION organizer_reject_history_mutation();
CREATE TRIGGER organizer_audit_immutable BEFORE UPDATE OR DELETE ON organizer_audit_events
 FOR EACH ROW EXECUTE FUNCTION organizer_reject_history_mutation();
