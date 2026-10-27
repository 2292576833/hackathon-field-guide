-- Root proposal only. Assign the next incremental migration; no plaintext email or authorization code is stored.
CREATE TABLE organizer_mail_accounts (
 organization_id text PRIMARY KEY REFERENCES organizer_organizations(id),
 revision integer NOT NULL CHECK(revision>0),
 state text NOT NULL CHECK(state IN ('verified','disabled')),
 provider text CHECK(provider IN ('qq','163','126','gmail')),
 masked_email text, credential jsonb, verified_at timestamptz, updated_at timestamptz NOT NULL,
 CHECK((state='verified' AND provider IS NOT NULL AND masked_email IS NOT NULL AND credential IS NOT NULL AND verified_at IS NOT NULL)
    OR (state='disabled' AND credential IS NULL AND verified_at IS NULL)),
 CHECK(credential IS NULL OR jsonb_typeof(credential)='object')
);
CREATE TABLE organizer_mail_account_audit (
 id text PRIMARY KEY, sequence bigserial UNIQUE,
 organization_id text NOT NULL REFERENCES organizer_organizations(id),
 revision integer NOT NULL CHECK(revision>0), actor_user_id text NOT NULL REFERENCES auth_users(id),
 action text NOT NULL CHECK(action IN ('verified_saved','disabled')),
 before_metadata jsonb NOT NULL, after_metadata jsonb NOT NULL, recorded_at timestamptz NOT NULL,
 UNIQUE(organization_id,revision)
);
CREATE TABLE organizer_mail_verification_attempts (
 id text PRIMARY KEY, sequence bigserial UNIQUE,
 organization_id text NOT NULL REFERENCES organizer_organizations(id),
 actor_user_id text NOT NULL REFERENCES auth_users(id),
 state text NOT NULL CHECK(state IN ('verifying','verified','failed','unknown_hold')),
 requested_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE INDEX organizer_mail_verification_org_time ON organizer_mail_verification_attempts(organization_id,requested_at DESC);
CREATE FUNCTION organizer_mail_verification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Organizer verification attempts cannot be deleted'; END IF;
 IF OLD.state<>'verifying' OR NEW.state='verifying' OR NEW.id<>OLD.id OR NEW.sequence<>OLD.sequence
    OR NEW.organization_id<>OLD.organization_id OR NEW.actor_user_id<>OLD.actor_user_id OR NEW.requested_at<>OLD.requested_at THEN
  RAISE EXCEPTION 'Organizer verification facts are immutable';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER organizer_mail_verification_guard BEFORE UPDATE OR DELETE ON organizer_mail_verification_attempts
 FOR EACH ROW EXECUTE FUNCTION organizer_mail_verification_guard();
CREATE FUNCTION organizer_mail_account_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Organizer mail account audit is immutable'; END;
$$;
CREATE TRIGGER organizer_mail_account_audit_immutable BEFORE UPDATE OR DELETE ON organizer_mail_account_audit
 FOR EACH ROW EXECUTE FUNCTION organizer_mail_account_audit_immutable();
