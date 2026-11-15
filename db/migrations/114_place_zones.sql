-- 114: a compound's extra areas ("also in"): Golden Square, South 90th, Sadat Axis… beyond its own area and sub-zone. A zone is
-- an ordinary areas row; this only links a compound to it, so a search for the zone can find the compound's units.
-- Roll back: DROP TABLE place_zones;
CREATE TABLE IF NOT EXISTS place_zones (
  place_id uuid NOT NULL REFERENCES map_places(id) ON DELETE CASCADE,
  area_id uuid NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('seed', 'manual')),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (place_id, area_id)
);
CREATE INDEX IF NOT EXISTS place_zones_area ON place_zones (area_id);
ALTER TABLE place_zones ENABLE ROW LEVEL SECURITY;
