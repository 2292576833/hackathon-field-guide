-- Proposal only. The coordinator assigns the root migration number and executes it.
-- Apply after the auth_users table exists. Existing accounts need no backfill.
CREATE TABLE participant_profiles (
  user_id text PRIMARY KEY REFERENCES auth_users(id),
  revision integer NOT NULL CHECK (revision > 0),
  first_hackathon boolean,
  development_experience text CHECK (development_experience IN ('none', 'beginner', 'project', 'experienced')),
  city text NOT NULL DEFAULT '' CHECK (length(city) <= 80),
  skills text[] NOT NULL DEFAULT ARRAY[]::text[]
    CHECK (cardinality(skills) <= 30 AND array_position(skills, NULL) IS NULL),
  interests text[] NOT NULL DEFAULT ARRAY[]::text[]
    CHECK (cardinality(interests) <= 30 AND array_position(interests, NULL) IS NULL),
  project_idea text NOT NULL DEFAULT '' CHECK (length(project_idea) <= 4000),
  available_hours_per_day double precision CHECK (available_hours_per_day BETWEEN 0 AND 24),
  travel_preference text NOT NULL DEFAULT 'undecided' CHECK (travel_preference IN ('undecided', 'rail', 'flight', 'local')),
  presentation_experience text CHECK (presentation_experience IN ('none', 'some', 'confident')),
  updated_at timestamptz NOT NULL
);

-- No model output or required-profile flag is stored here. A saved profile can remain incomplete.
-- The user can clear every optional field via a revision-checked update.
-- Rollback is coordinator-owned: preserve/export private profile data before removing the table.
