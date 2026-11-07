-- 087_list_indexes.sql: one index so the units list (newest confirmed first, 20 per page) reads only the rows it shows (patch 5).
-- Found by the 50,000-unit query-plan test: without it the list read every unit of the agency and sorted them.
CREATE INDEX IF NOT EXISTS listings_agency_status_confirmed_idx ON listings (agency_id, status, confirmed_at DESC NULLS LAST, created_at DESC, id DESC);
