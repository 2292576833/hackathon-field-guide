-- Root migration suggestion only: runtime never executes DDL.
-- The worker cannot publish, withdraw or alter resource_records.
CREATE TABLE resource_link_maintenance_state (
  id text PRIMARY KEY CHECK(id='approved_resources'),
  cycle bigint NOT NULL DEFAULT 0 CHECK(cycle>=0),
  lease_token text, lease_until timestamptz,
  next_eligible_at timestamptz NOT NULL,
  last_started_at timestamptz, last_completed_at timestamptz,
  CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE TABLE resource_link_maintenance_sites (
  hostname text PRIMARY KEY,
  last_attempt_at timestamptz NOT NULL,
  next_eligible_at timestamptz NOT NULL,
  CHECK(next_eligible_at>=last_attempt_at+interval '24 hours')
);
CREATE TABLE resource_link_check_results (
  resource_id text NOT NULL REFERENCES resource_records(id) ON DELETE RESTRICT,
  resource_revision integer NOT NULL CHECK(resource_revision>0),
  resource_version integer NOT NULL CHECK(resource_version>0),
  hostname text NOT NULL,
  checked_at timestamptz NOT NULL,
  status text NOT NULL CHECK(status IN ('available','unreachable','unknown')),
  reason text NOT NULL CHECK(reason IN ('http_success','http_not_found','http_restricted','head_unsupported','redirect_not_approved','redirect_limit','request_timeout','network_error','network_address_blocked','http_other','robots_disallowed','robots_unavailable','resource_changed')),
  http_status integer CHECK(http_status BETWEEN 100 AND 599),
  cycle bigint NOT NULL CHECK(cycle>0),
  PRIMARY KEY(resource_id,resource_revision)
);
CREATE INDEX resource_link_check_recent ON resource_link_check_results(checked_at DESC,resource_id);
