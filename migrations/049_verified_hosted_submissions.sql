-- A server-owned organizer receipt may confirm receipt of materials. Public M06
-- handlers retain their user_reported-only input contract; this does not verify execution.
ALTER TABLE m06_submission_versions DROP CONSTRAINT m06_submission_versions_verification_source_check;
ALTER TABLE m06_submission_versions DROP CONSTRAINT m06_submission_versions_status_check;
ALTER TABLE m06_submission_versions ADD CONSTRAINT m06_submission_versions_verification_source_check CHECK (verification_source IN ('user_reported','platform_verified'));
ALTER TABLE m06_submission_versions ADD CONSTRAINT m06_submission_versions_status_check CHECK (status IN ('not_submitted','reported','verified','rejected_or_withdrawn'));
ALTER TABLE m06_submission_versions ADD CONSTRAINT m06_trusted_receipt CHECK (
 (verification_source <> 'platform_verified' OR (status='verified' AND submitted_at IS NOT NULL AND cardinality(evidence_refs)>0))
 AND (status <> 'verified' OR verification_source='platform_verified')
);
