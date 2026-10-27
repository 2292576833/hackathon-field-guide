-- A configured organization must not wait behind another organization's unsent mail.
-- This is scheduling metadata only; a deferred item has not reached the SMTP server.
ALTER TABLE organizer_notification_outbox ADD COLUMN next_attempt_at timestamptz;
CREATE INDEX organizer_notification_outbox_ready ON organizer_notification_outbox(state,next_attempt_at,sequence);
