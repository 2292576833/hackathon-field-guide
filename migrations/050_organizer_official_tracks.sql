-- Root integration proposal only. Assign a fresh incremental migration before actual application.
CREATE TABLE organizer_track_configurations (
 event_id text PRIMARY KEY,
 organization_id text NOT NULL,
 revision integer NOT NULL CHECK(revision > 0),
 required boolean NOT NULL,
 options jsonb NOT NULL CHECK(jsonb_typeof(options)='array' AND jsonb_array_length(options)<=20),
 FOREIGN KEY(event_id,organization_id) REFERENCES organizer_hosted_events(id,organization_id),
 CHECK(NOT required OR jsonb_array_length(options)>0)
);
CREATE TABLE organizer_track_versions (
 id text PRIMARY KEY,
 event_id text NOT NULL,
 organization_id text NOT NULL,
 revision integer NOT NULL CHECK(revision > 0),
 changed_by text NOT NULL REFERENCES auth_users(id),
 changed_at timestamptz NOT NULL,
 before_configuration jsonb NOT NULL CHECK(jsonb_typeof(before_configuration)='object'),
 configuration jsonb NOT NULL CHECK(jsonb_typeof(configuration)='object'),
 FOREIGN KEY(event_id,organization_id) REFERENCES organizer_hosted_events(id,organization_id),
 UNIQUE(event_id,revision),
 CHECK(configuration->>'configured'='true' AND (configuration->>'revision')::integer=revision)
);
CREATE FUNCTION reject_organizer_track_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Organizer track versions are immutable'; END $$;
CREATE TRIGGER organizer_track_versions_immutable BEFORE UPDATE OR DELETE ON organizer_track_versions FOR EACH ROW EXECUTE FUNCTION reject_organizer_track_version_mutation();
