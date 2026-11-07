-- 088_search_review.sql: search review upgrade (deferred from patch 3, approved by the owner 2026-11-06).
-- 1) The owner can teach a word of more kinds: furnishing, finishing and sale/rent, not only place, type and feature.
-- 2) A test case can carry the filters the search should produce ("expected"); a case with expected filters passes or fails each
--    time it is run, so a parser rule problem sits as a failing case until the rule is fixed in code.
ALTER TABLE search_aliases DROP CONSTRAINT IF EXISTS search_aliases_kind_check;
ALTER TABLE search_aliases ADD CONSTRAINT search_aliases_kind_check CHECK (kind IN ('place', 'type', 'feature', 'furnishing', 'finishing', 'listing_type'));
ALTER TABLE search_test_cases ADD COLUMN IF NOT EXISTS expected jsonb;
ALTER TABLE search_test_cases ADD COLUMN IF NOT EXISTS note text;
