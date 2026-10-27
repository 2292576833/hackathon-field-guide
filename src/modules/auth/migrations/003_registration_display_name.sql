-- Proposal only: coordinator must copy into a new incremental root migration.
-- Existing pending login challenges remain valid and do not gain a registration name.
ALTER TABLE auth_login_challenges
  ADD COLUMN registration_display_name text
  CHECK (registration_display_name IS NULL OR
    (length(registration_display_name) BETWEEN 1 AND 60 AND
      registration_display_name = btrim(registration_display_name) AND
      registration_display_name !~ '[[:cntrl:]]'));
