-- 091: Places on the map (compounds and projects with a pin). Global: one row per compound for every agency; only the CRM
-- owner edits them (/app/owner/map). A unit shows on a pin when its compound name equals the place's English name, Arabic
-- name or one of its aliases (domain/mapPlaces.js). verified = the owner checked the coordinates.
CREATE TABLE IF NOT EXISTS map_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name_key text NOT NULL UNIQUE,
  name_en text,
  name_ar text,
  developer text,
  district text,
  lat double precision NOT NULL CHECK (lat BETWEEN 21 AND 32),
  lng double precision NOT NULL CHECK (lng BETWEEN 24 AND 37),
  aliases text[] NOT NULL DEFAULT '{}',
  verified boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('seed', 'manual')),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS map_places_verified ON map_places (verified);
ALTER TABLE map_places ENABLE ROW LEVEL SECURITY;
