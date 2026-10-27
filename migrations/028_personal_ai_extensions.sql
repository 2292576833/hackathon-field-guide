-- Additional explicitly requested private artifacts. Existing data is retained.
ALTER TABLE personal_ai_artifacts DROP CONSTRAINT personal_ai_artifacts_kind_check;
ALTER TABLE personal_ai_artifacts ADD CONSTRAINT personal_ai_artifacts_kind_check
  CHECK (kind IN ('participation_plan','roadshow','ppt','profile_summary','project_feasibility','space_assistant_reply'));
