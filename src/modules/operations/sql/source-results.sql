-- Root integration proposal: immutable worker receipts, not a second published event store.
CREATE TABLE integration_source_results (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES operations_execution_runs(id), attempt integer NOT NULL CHECK(attempt > 0),
  kind text NOT NULL CHECK(kind IN ('crawl','analysis')), source_config_id text NOT NULL REFERENCES operations_source_configs(id),
  source_revision integer NOT NULL CHECK(source_revision > 0), target_url text NOT NULL,
  input_hash text NOT NULL CHECK(input_hash ~ '^[0-9a-f]{64}$'), request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  event_id text NOT NULL REFERENCES m03_events(id), payload jsonb NOT NULL CHECK((jsonb_typeof(payload)='object') IS TRUE),
  created_at timestamptz NOT NULL, UNIQUE(run_id,attempt)
);
CREATE INDEX integration_source_results_input ON integration_source_results(source_config_id,target_url,created_at DESC);
CREATE OR REPLACE FUNCTION integration_source_results_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Worker source receipts are immutable'; END $$;
CREATE TRIGGER integration_source_results_immutable_guard BEFORE UPDATE OR DELETE ON integration_source_results
FOR EACH ROW EXECUTE FUNCTION integration_source_results_immutable();
