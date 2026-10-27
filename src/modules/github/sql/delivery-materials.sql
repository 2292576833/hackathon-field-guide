-- Incremental proposal only. Root owns actual migration number and user/project FKs.
CREATE TABLE m06_delivery_material_heads (
  project_id text PRIMARY KEY,
  id text NOT NULL UNIQUE,
  version integer NOT NULL CHECK (version > 0)
);
CREATE TABLE m06_delivery_material_versions (
  project_id text NOT NULL,
  id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  recorded_by text NOT NULL,
  idempotency_key text NOT NULL,
  input_hash text NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY (project_id,version),
  UNIQUE (id,version),
  UNIQUE (project_id,recorded_by,idempotency_key),
  FOREIGN KEY (id) REFERENCES m06_delivery_material_heads(id),
  CHECK (jsonb_typeof(body)='object' AND body->>'projectId'=project_id AND body->>'id'=id
    AND body->>'recordedBy'=recorded_by AND body->>'idempotencyKey'=idempotency_key
    AND body->>'inputHash'=input_hash AND (body->>'version')::integer=version
    AND jsonb_typeof(body->'entries')='array')
);
CREATE TABLE m06_delivery_material_events (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  checklist_id text NOT NULL,
  version integer NOT NULL,
  actor_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  details jsonb NOT NULL,
  FOREIGN KEY (checklist_id,version) REFERENCES m06_delivery_material_versions(id,version)
);
CREATE FUNCTION m06_immutable_delivery_material_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'delivery material history is immutable' USING ERRCODE='23514'; END
$$;
CREATE TRIGGER m06_delivery_material_version_immutable BEFORE UPDATE OR DELETE ON m06_delivery_material_versions
FOR EACH ROW EXECUTE FUNCTION m06_immutable_delivery_material_version();
CREATE TRIGGER m06_delivery_material_event_immutable BEFORE UPDATE OR DELETE ON m06_delivery_material_events
FOR EACH ROW EXECUTE FUNCTION m06_immutable_delivery_material_version();
