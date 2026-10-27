-- Root-owned, event-scoped human relationship checks. Append-only evidence.
CREATE TABLE organizer_relationship_reviews (
 id text PRIMARY KEY,
 sequence bigserial NOT NULL UNIQUE,
 organization_id text NOT NULL,
 event_id text NOT NULL,
 team_id text NOT NULL,
 judge_user_id text NOT NULL REFERENCES auth_users(id),
 reviewed_by text NOT NULL REFERENCES auth_users(id),
 team_revision integer NOT NULL CHECK (team_revision > 0),
 state text NOT NULL CHECK (state IN ('clear','conflict')),
 note text NOT NULL CHECK (length(note) BETWEEN 1 AND 2000),
 reviewed_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 FOREIGN KEY (event_id, organization_id) REFERENCES organizer_hosted_events(id, organization_id),
 FOREIGN KEY (event_id, team_id) REFERENCES event_registration_teams(event_id, id),
 CHECK (judge_user_id <> reviewed_by)
);
CREATE INDEX organizer_relationship_review_lookup ON organizer_relationship_reviews(event_id, team_id, judge_user_id, reviewed_at DESC, id DESC);
CREATE FUNCTION reject_organizer_relationship_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Relationship review evidence is immutable'; END $$;
CREATE TRIGGER organizer_relationship_immutable BEFORE UPDATE OR DELETE ON organizer_relationship_reviews FOR EACH ROW EXECUTE FUNCTION reject_organizer_relationship_mutation();
