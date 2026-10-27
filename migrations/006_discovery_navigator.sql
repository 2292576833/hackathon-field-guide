CREATE TABLE event_discovery_cards (
  id text PRIMARY KEY,
  canonical_url text NOT NULL UNIQUE,
  revision integer NOT NULL CHECK (revision > 0),
  content_hash text NOT NULL,
  content jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  discovered_at timestamptz NOT NULL,
  last_analyzed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_discovery_cards_feed ON event_discovery_cards(status, last_analyzed_at DESC, id DESC);
CREATE TABLE event_discovery_versions (
  card_id text NOT NULL REFERENCES event_discovery_cards(id),
  revision integer NOT NULL,
  content_hash text NOT NULL,
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (card_id,revision)
);
CREATE TABLE navigator_request_budgets (
  actor_id text NOT NULL REFERENCES auth_users(id),
  window_start timestamptz NOT NULL,
  calls integer NOT NULL CHECK (calls > 0),
  PRIMARY KEY (actor_id,window_start)
);
