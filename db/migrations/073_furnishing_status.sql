-- 073: "kitchen and AC" is a furnishing status (Haytham 2026-11-04), next to unfurnished, furnished, AC only and kitchen only.
-- The column's check now allows the three new values. Units that have both features and no furnishing status yet get
-- "kitchen_and_ac"; their features stay as they are, and a unit already marked furnished keeps that status.
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_furnishing_check;
ALTER TABLE listings ADD CONSTRAINT listings_furnishing_check
  CHECK (furnishing = ANY (ARRAY['furnished', 'semi_furnished', 'unfurnished', 'kitchen_and_ac', 'ac_only', 'kitchen_only']::text[]));
UPDATE listings
   SET furnishing = 'kitchen_and_ac'
 WHERE furnishing IS NULL
   AND feature_keys @> ARRAY['kitchen_installed', 'ac_installed']::text[];
