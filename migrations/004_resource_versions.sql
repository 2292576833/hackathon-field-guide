ALTER TABLE projects_resource_bookmark ADD COLUMN IF NOT EXISTS resource_version integer;
-- Existing installations must review/backfill any prior reviewed-resource references;
-- never invent a historical content version. The empty initial development schema needs no backfill.
ALTER TABLE projects_resource_bookmark ADD CONSTRAINT project_resource_version_positive
CHECK ((resource_id IS NULL AND resource_version IS NULL)
  OR (resource_id IS NOT NULL AND resource_version IS NOT NULL AND resource_version > 0));
ALTER TABLE projects_resource_bookmark ADD CONSTRAINT project_resource_content_fk FOREIGN KEY(resource_id) REFERENCES resource_records(id) ON DELETE RESTRICT;
