CREATE TABLE inspiration_cards (
  id text PRIMARY KEY, revision integer NOT NULL CHECK(revision>0),
  content_hash text NOT NULL, content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'),
  last_analyzed_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE inspiration_versions (
  card_id text NOT NULL REFERENCES inspiration_cards(id), revision integer NOT NULL,
  content_hash text NOT NULL, content jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(card_id,revision)
);
ALTER TABLE backend_worker_heartbeats DROP CONSTRAINT backend_worker_heartbeats_kind_check;
ALTER TABLE backend_worker_heartbeats ADD CONSTRAINT backend_worker_heartbeats_kind_check
  CHECK(kind IN ('ai','source','discovery','inspiration'));
