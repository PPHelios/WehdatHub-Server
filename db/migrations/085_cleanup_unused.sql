-- 085_cleanup_unused.sql: production cleanup from the 2026-11-06 audit (patch 1).
-- 1. Drop indexes that the live database reports as never used (low traffic so far; the search,
--    privacy and matching indexes are kept on purpose and reviewed in the load patch).
-- 2. Drop the duplicate broker foreign key on units. Both copies existed; the plain one blocks
--    deleting a broker, the other clears the link. We keep the clearing one so units stay when a broker row is removed.
--    Behaviour change to confirm with the owner before running live.
-- 3. Move the trigram extension out of the public schema (no app code calls it directly).
--    The extension used by Supabase's own network helper is left alone.

DROP INDEX IF EXISTS idx_op_logs_listing_code;
DROP INDEX IF EXISTS idx_listing_drafts_updated;
DROP INDEX IF EXISTS idx_projects_developer;
DROP INDEX IF EXISTS idx_commissions_developer;
DROP INDEX IF EXISTS lead_intake_log_intake_idx;
DROP INDEX IF EXISTS search_log_disagree;
DROP INDEX IF EXISTS share_links_recipient_idx;

ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_broker_id_fkey;

CREATE SCHEMA IF NOT EXISTS extensions;
ALTER EXTENSION pg_trgm SET SCHEMA extensions;
