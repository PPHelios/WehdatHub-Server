-- 085_cleanup_unused.sql: drop indexes the live database reports as never used (patch 1, audit 2026-11-06).
-- Runs automatically on deploy (MIGRATE_ON_BOOT defaults on), so merging the PR applies it live.
-- Kept on purpose: search, privacy and matching indexes (reviewed in the load patch).
-- Not in this file, waiting for owner approval: removing the duplicate broker key on units (changes what
-- happens when a broker row is deleted) and moving the trigram extension out of the public schema.

DROP INDEX IF EXISTS idx_op_logs_listing_code;
DROP INDEX IF EXISTS idx_listing_drafts_updated;
DROP INDEX IF EXISTS idx_projects_developer;
DROP INDEX IF EXISTS idx_commissions_developer;
DROP INDEX IF EXISTS lead_intake_log_intake_idx;
DROP INDEX IF EXISTS search_log_disagree;
DROP INDEX IF EXISTS share_links_recipient_idx;
