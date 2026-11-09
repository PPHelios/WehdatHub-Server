-- 098: one shared list of areas and sub-zones. An area has no parent; a sub-zone has a parent (up to 3 levels, e.g. New Cairo >
-- Al Banafseg > Banafseg 1). Global, like map_places: names and aliases are the same for every agency. A compound
-- (map_places) and a unit (listings) point at their area, and optionally at a sub-zone below it. Existing columns stay:
-- map_places.district is the old free text and is kept until every compound has an area.
-- Roll back: ALTER TABLE listings DROP COLUMN area_id, DROP COLUMN subzone_id; ALTER TABLE map_places DROP COLUMN area_id,
-- DROP COLUMN subzone_id; DROP TABLE areas.
CREATE TABLE IF NOT EXISTS areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid REFERENCES areas(id) ON DELETE RESTRICT,
  name_key text NOT NULL,
  name_en text,
  name_ar text,
  aliases text[] NOT NULL DEFAULT '{}',
  lat double precision CHECK (lat IS NULL OR lat BETWEEN 21 AND 32),
  lng double precision CHECK (lng IS NULL OR lng BETWEEN 24 AND 37),
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('seed', 'manual', 'broker')),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CHECK (name_en IS NOT NULL OR name_ar IS NOT NULL)
);
-- One name per parent (two sub-zones named "1st District" can sit under different areas).
CREATE UNIQUE INDEX IF NOT EXISTS areas_parent_key ON areas (COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name_key);
CREATE INDEX IF NOT EXISTS areas_parent ON areas (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS areas_status ON areas (status);
ALTER TABLE areas ENABLE ROW LEVEL SECURITY;

-- A parent chain is at most three deep and never loops.
CREATE OR REPLACE FUNCTION areas_check_depth() RETURNS trigger AS $$
DECLARE
  depth integer := 1;
  cur uuid := NEW.parent_id;
BEGIN
  WHILE cur IS NOT NULL LOOP
    IF cur = NEW.id THEN RAISE EXCEPTION 'an area cannot sit under itself'; END IF;
    depth := depth + 1;
    IF depth > 3 THEN RAISE EXCEPTION 'areas go three levels deep at most'; END IF;
    SELECT parent_id INTO cur FROM areas WHERE id = cur;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS areas_depth ON areas;
CREATE TRIGGER areas_depth BEFORE INSERT OR UPDATE OF parent_id ON areas FOR EACH ROW EXECUTE FUNCTION areas_check_depth();

-- A sub-zone chosen on a compound or a unit must sit under the chosen area (directly or lower down).
CREATE OR REPLACE FUNCTION area_subzone_check() RETURNS trigger AS $$
DECLARE
  cur uuid := NEW.subzone_id;
  ok boolean := false;
BEGIN
  IF NEW.subzone_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.area_id IS NULL THEN RAISE EXCEPTION 'a sub-zone needs its area'; END IF;
  WHILE cur IS NOT NULL LOOP
    SELECT parent_id INTO cur FROM areas WHERE id = cur;
    IF cur = NEW.area_id THEN ok := true; EXIT; END IF;
  END LOOP;
  IF NOT ok THEN RAISE EXCEPTION 'the sub-zone is not under the chosen area'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE map_places ADD COLUMN IF NOT EXISTS area_id uuid REFERENCES areas(id) ON DELETE SET NULL;
ALTER TABLE map_places ADD COLUMN IF NOT EXISTS subzone_id uuid REFERENCES areas(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS map_places_area ON map_places (area_id) WHERE area_id IS NOT NULL;
DROP TRIGGER IF EXISTS map_places_subzone ON map_places;
CREATE TRIGGER map_places_subzone BEFORE INSERT OR UPDATE OF area_id, subzone_id ON map_places FOR EACH ROW EXECUTE FUNCTION area_subzone_check();

ALTER TABLE listings ADD COLUMN IF NOT EXISTS area_id uuid REFERENCES areas(id) ON DELETE SET NULL;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS subzone_id uuid REFERENCES areas(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_listings_area ON listings (agency_id, area_id) WHERE area_id IS NOT NULL;
DROP TRIGGER IF EXISTS listings_subzone ON listings;
CREATE TRIGGER listings_subzone BEFORE INSERT OR UPDATE OF area_id, subzone_id ON listings FOR EACH ROW EXECUTE FUNCTION area_subzone_check();
