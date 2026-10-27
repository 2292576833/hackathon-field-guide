-- Maintenance loops use the same durable heartbeat table as discovery/AI.
-- Preserve existing rows and admit only the nine application-owned worker kinds.
ALTER TABLE backend_worker_heartbeats DROP CONSTRAINT backend_worker_heartbeats_kind_check;
ALTER TABLE backend_worker_heartbeats ADD CONSTRAINT backend_worker_heartbeats_kind_check
  CHECK (kind IN ('ai','source','discovery','inspiration','planning-notifications',
    'github-maintenance','retention-maintenance','resource-links','organizer-notifications'));
