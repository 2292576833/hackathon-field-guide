-- Proposal only. Root copies to a new numbered migration; never run against production from this module.
CREATE TABLE recruiting_profiles (
  user_id text PRIMARY KEY,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  data jsonb NOT NULL,
  avatar_revision integer NOT NULL DEFAULT 0 CHECK (avatar_revision >= 0),
  avatar_mime text CHECK (avatar_mime IN ('image/png','image/jpeg','image/webp')),
  avatar_bytes bytea CHECK (octet_length(avatar_bytes) <= 524288),
  updated_at timestamptz,
  CHECK ((avatar_mime IS NULL) = (avatar_bytes IS NULL))
);
CREATE TABLE recruiting_cards (
  id text PRIMARY KEY, user_id text NOT NULL UNIQUE,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('published','withdrawn')),
  body jsonb,
  avatar_mime text CHECK (avatar_mime IN ('image/png','image/jpeg','image/webp')),
  avatar_bytes bytea CHECK (octet_length(avatar_bytes) <= 524288),
  updated_at timestamptz NOT NULL,
  CHECK ((status='published') = (body IS NOT NULL)),
  CHECK ((avatar_mime IS NULL) = (avatar_bytes IS NULL))
);
CREATE TABLE recruiting_posts (
  id text PRIMARY KEY, project_id text NOT NULL UNIQUE, publisher_user_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('open','closed','withdrawn')), body jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE recruiting_applications (
  id text PRIMARY KEY, post_id text NOT NULL REFERENCES recruiting_posts(id),
  project_id text NOT NULL, applicant_user_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('pending','approved','rejected','withdrawn','joined')),
  request_id text NOT NULL, body jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(post_id,applicant_user_id)
);
CREATE TABLE recruiting_history (
  id text PRIMARY KEY, entity_type text NOT NULL CHECK (entity_type IN ('profile','avatar','card','post','application')),
  entity_id text NOT NULL, revision integer NOT NULL, actor_user_id text NOT NULL,
  action text NOT NULL, body jsonb NOT NULL, occurred_at timestamptz NOT NULL,
  UNIQUE(entity_type,entity_id,revision)
);
CREATE INDEX recruiting_cards_public ON recruiting_cards(id) WHERE status='published';
CREATE INDEX recruiting_posts_public ON recruiting_posts(id) WHERE status IN ('open','closed');
CREATE INDEX recruiting_applications_owner ON recruiting_applications(applicant_user_id,updated_at DESC);
CREATE INDEX recruiting_applications_post ON recruiting_applications(post_id,updated_at DESC);
-- Keep tombstones/history. Rollback only through coordinated backups, never DROP shared identities/memberships.
