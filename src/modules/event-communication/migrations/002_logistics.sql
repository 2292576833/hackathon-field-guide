-- O03 proposal only. Root owns real migration numbering/execution.
-- Organization/event identity is obtained through HostedEventAccessPort. No other module tables read.
CREATE TABLE ec_accommodation_assignments (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  user_id text NOT NULL REFERENCES auth_users(id),
  revision integer NOT NULL CHECK (revision > 0),
  document jsonb NOT NULL,
  UNIQUE(organization_id,event_id,user_id),
  UNIQUE(organization_id,event_id,id)
);
CREATE TABLE ec_accommodation_versions (
  organization_id text NOT NULL,
  event_id text NOT NULL,
  assignment_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  document jsonb NOT NULL,
  PRIMARY KEY(organization_id,event_id,assignment_id,revision),
  FOREIGN KEY(organization_id,event_id,assignment_id) REFERENCES ec_accommodation_assignments(organization_id,event_id,id)
);
CREATE TABLE ec_accommodation_imports (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  user_id text NOT NULL REFERENCES auth_users(id),
  state text NOT NULL CHECK (state IN ('preview','confirmed')),
  document jsonb NOT NULL,
  UNIQUE(organization_id,event_id,id)
);
CREATE TABLE ec_voucher_types (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  document jsonb NOT NULL,
  UNIQUE(organization_id,event_id,id)
);
CREATE TABLE ec_meal_vouchers (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  user_id text NOT NULL REFERENCES auth_users(id),
  type_id text NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  total_uses integer NOT NULL CHECK (total_uses BETWEEN 1 AND 100),
  remaining_uses integer NOT NULL CHECK (remaining_uses >= 0 AND remaining_uses <= total_uses),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by text REFERENCES auth_users(id),
  revision integer NOT NULL CHECK (revision > 0),
  document jsonb NOT NULL,
  UNIQUE(organization_id,event_id,id),
  FOREIGN KEY(organization_id,event_id,type_id) REFERENCES ec_voucher_types(organization_id,event_id,id)
);
CREATE INDEX ec_meal_vouchers_owner ON ec_meal_vouchers(organization_id,event_id,user_id);
CREATE TABLE ec_voucher_issues (
  organization_id text NOT NULL,
  event_id text NOT NULL,
  operator_user_id text NOT NULL REFERENCES auth_users(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  voucher_id text NOT NULL,
  PRIMARY KEY(organization_id,event_id,operator_user_id,idempotency_key),
  FOREIGN KEY(organization_id,event_id,voucher_id) REFERENCES ec_meal_vouchers(organization_id,event_id,id)
);
CREATE TABLE ec_voucher_redemptions (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  event_id text NOT NULL,
  operator_user_id text NOT NULL REFERENCES auth_users(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  voucher_id text NOT NULL,
  document jsonb NOT NULL,
  UNIQUE(organization_id,event_id,operator_user_id,idempotency_key),
  FOREIGN KEY(organization_id,event_id,voucher_id) REFERENCES ec_meal_vouchers(organization_id,event_id,id)
);
CREATE TABLE ec_voucher_versions (
  organization_id text NOT NULL,
  event_id text NOT NULL,
  voucher_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  action text NOT NULL CHECK (action IN ('issued','redeemed','revoked')),
  operator_user_id text NOT NULL REFERENCES auth_users(id),
  document jsonb NOT NULL,
  PRIMARY KEY(organization_id,event_id,voucher_id,revision),
  FOREIGN KEY(organization_id,event_id,voucher_id) REFERENCES ec_meal_vouchers(organization_id,event_id,id)
);
CREATE FUNCTION ec_logistics_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ec logistics history is immutable';
END;
$$;
CREATE TRIGGER ec_accommodation_versions_immutable BEFORE UPDATE OR DELETE ON ec_accommodation_versions
  FOR EACH ROW EXECUTE FUNCTION ec_logistics_history_immutable();
CREATE TRIGGER ec_voucher_versions_immutable BEFORE UPDATE OR DELETE ON ec_voucher_versions
  FOR EACH ROW EXECUTE FUNCTION ec_logistics_history_immutable();
CREATE TRIGGER ec_voucher_redemptions_immutable BEFORE UPDATE OR DELETE ON ec_voucher_redemptions
  FOR EACH ROW EXECUTE FUNCTION ec_logistics_history_immutable();
