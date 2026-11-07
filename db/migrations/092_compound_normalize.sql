-- 092: compounds are picked from one approved list. A place is "approved" once the CRM owner has checked it (places added by
-- hand or marked verified start approved; the unreviewed seed does not). A unit keeps the place it was matched to
-- (place_id) and a state: NULL = nothing to fix, 'needs_fix' = the name did not match an approved place.
ALTER TABLE map_places ADD COLUMN IF NOT EXISTS approved boolean NOT NULL DEFAULT false;
UPDATE map_places SET approved = true WHERE source = 'manual' OR verified;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS place_id uuid REFERENCES map_places(id) ON DELETE SET NULL;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS compound_state text CHECK (compound_state IS NULL OR compound_state = 'needs_fix');
CREATE INDEX IF NOT EXISTS idx_listings_place ON listings (agency_id, place_id) WHERE place_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_listings_needs_fix ON listings (agency_id) WHERE compound_state = 'needs_fix';
