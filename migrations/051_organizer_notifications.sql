-- Root proposal: assign a new incremental migration. No email addresses or mail bodies in the outbox.
CREATE TABLE organizer_selection_templates (
 event_id text PRIMARY KEY, organization_id text NOT NULL,
 revision integer NOT NULL CHECK(revision>0), document jsonb NOT NULL,
 FOREIGN KEY(event_id,organization_id) REFERENCES organizer_hosted_events(id,organization_id)
);
CREATE TABLE organizer_selection_template_versions (
 event_id text NOT NULL, organization_id text NOT NULL, revision integer NOT NULL CHECK(revision>0),
 document jsonb NOT NULL, changed_by text NOT NULL REFERENCES auth_users(id), changed_at timestamptz NOT NULL,
 PRIMARY KEY(event_id,revision),
 FOREIGN KEY(event_id,organization_id) REFERENCES organizer_hosted_events(id,organization_id)
);
CREATE TABLE organizer_selection_notices (
 id text PRIMARY KEY, sequence bigserial UNIQUE, organization_id text NOT NULL, event_id text NOT NULL,
 registration_id text NOT NULL, registration_revision integer NOT NULL CHECK(registration_revision>0),
 recipient_user_id text NOT NULL REFERENCES auth_users(id), version integer NOT NULL CHECK(version>0),
 operation_key text NOT NULL, template_revision integer NOT NULL CHECK(template_revision>0),
 subject text NOT NULL, body text NOT NULL, accent text NOT NULL CHECK(accent IN ('orange','blue','green','slate')),
 theme text NOT NULL CHECK(theme IN ('simple','letter')), published_by text NOT NULL REFERENCES auth_users(id),
 published_at timestamptz NOT NULL, mail_configured boolean NOT NULL,
 UNIQUE(event_id,registration_id,registration_revision,version),
 UNIQUE(event_id,registration_id,registration_revision,operation_key),
 UNIQUE(id,event_id,organization_id),
 FOREIGN KEY(event_id,organization_id) REFERENCES organizer_hosted_events(id,organization_id)
);
CREATE INDEX organizer_selection_notices_recipient ON organizer_selection_notices(event_id,recipient_user_id,sequence DESC);
CREATE TABLE organizer_notification_batches (
 id text PRIMARY KEY, organization_id text NOT NULL, event_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('announcement','selection')), source_id text NOT NULL,
 source_revision integer NOT NULL CHECK(source_revision>0), created_at timestamptz NOT NULL,
 UNIQUE(event_id,kind,source_id,source_revision), UNIQUE(id,event_id,organization_id),
 FOREIGN KEY(event_id,organization_id) REFERENCES organizer_hosted_events(id,organization_id)
);
CREATE TABLE organizer_notification_outbox (
 id text PRIMARY KEY, sequence bigserial UNIQUE, batch_id text NOT NULL, organization_id text NOT NULL, event_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('announcement','selection')), source_id text NOT NULL, source_revision integer NOT NULL CHECK(source_revision>0),
 recipient_user_id text NOT NULL REFERENCES auth_users(id), published_by text NOT NULL REFERENCES auth_users(id),
 registration_id text, registration_revision integer,
 state text NOT NULL CHECK(state IN ('queued','leased','sending','accepted','unknown_hold','failed','cancelled')),
 reason text, lease_token text, lease_until timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
 sending_at timestamptz, accepted_at timestamptz,
 UNIQUE(batch_id,recipient_user_id),
 FOREIGN KEY(batch_id,event_id,organization_id) REFERENCES organizer_notification_batches(id,event_id,organization_id),
 CHECK((kind='announcement' AND registration_id IS NULL AND registration_revision IS NULL) OR
       (kind='selection' AND registration_id IS NOT NULL AND registration_revision>0)),
 CHECK((state IN ('leased','sending'))=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK(state<>'accepted' OR accepted_at IS NOT NULL)
);
CREATE INDEX organizer_notification_outbox_work ON organizer_notification_outbox(state,lease_until,sequence);
CREATE INDEX organizer_notification_outbox_source ON organizer_notification_outbox(event_id,kind,source_id,source_revision);
CREATE TABLE organizer_notification_transitions (
 sequence bigserial PRIMARY KEY, outbox_id text NOT NULL REFERENCES organizer_notification_outbox(id),
 state text NOT NULL, reason text, recorded_at timestamptz NOT NULL
);
CREATE FUNCTION organizer_notification_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Organizer notification history is immutable'; END;
$$;
CREATE TRIGGER organizer_selection_versions_immutable BEFORE UPDATE OR DELETE ON organizer_selection_template_versions
 FOR EACH ROW EXECUTE FUNCTION organizer_notification_history_immutable();
CREATE TRIGGER organizer_selection_notices_immutable BEFORE UPDATE OR DELETE ON organizer_selection_notices
 FOR EACH ROW EXECUTE FUNCTION organizer_notification_history_immutable();
CREATE TRIGGER organizer_notification_batches_immutable BEFORE UPDATE OR DELETE ON organizer_notification_batches
 FOR EACH ROW EXECUTE FUNCTION organizer_notification_history_immutable();
CREATE TRIGGER organizer_notification_transitions_immutable BEFORE UPDATE OR DELETE ON organizer_notification_transitions
 FOR EACH ROW EXECUTE FUNCTION organizer_notification_history_immutable();
