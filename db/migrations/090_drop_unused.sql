-- Unused tables (empty, no code reads or writes them) and a duplicate foreign key. Approved by the owner 2026-11-07.
DROP TABLE IF EXISTS broker_search_state;
DROP TABLE IF EXISTS listing_drafts;
DROP TABLE IF EXISTS payment_plans;
DROP TABLE IF EXISTS processed_batches;
DROP TABLE IF EXISTS processed_messages;

-- listings had two identical agency links (listings_agency_id_fkey and fk_listings_agency): keep the first.
ALTER TABLE listings DROP CONSTRAINT IF EXISTS fk_listings_agency;
