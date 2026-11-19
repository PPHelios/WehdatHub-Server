-- 137: market analytics, history that cannot be rebuilt later. Aggregates only; nothing here names a person.
--  * analytics_search_daily: the nightly count of searches per day, place, type, sale/rent, bedroom band and budget band
--    (never the text, the broker, the agency or the result ids). analytics_meta holds "counted up to this day" so a rerun adds nothing twice.
--  * listing_prices: every change of listings.price_value is kept by a trigger, whatever wrote it (source 'edit' unless the writer retags the row).
--  * listing_status_events: every change of a unit's status (active, sold, archived, deleted) with the price at that moment.
-- Roll back: DROP TRIGGER listings_analytics_price_ins ON listings; DROP TRIGGER listings_analytics_price_upd ON listings; DROP TRIGGER listings_analytics_status ON listings; DROP FUNCTION analytics_listing_price(); DROP FUNCTION analytics_listing_status(); DROP TABLE listing_status_events, analytics_search_daily, analytics_meta;

CREATE TABLE IF NOT EXISTS analytics_meta (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE analytics_meta ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS analytics_search_daily (
  day date NOT NULL,
  area_id uuid,
  property_type text NOT NULL DEFAULT 'any',
  listing_type text NOT NULL DEFAULT 'any',
  bedroom_band text NOT NULL DEFAULT 'any',
  budget_band text NOT NULL DEFAULT 'any',
  searches integer NOT NULL DEFAULT 0 CHECK (searches >= 0),
  zero_result integer NOT NULL DEFAULT 0 CHECK (zero_result >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS analytics_search_daily_cell
  ON analytics_search_daily (day, (COALESCE(area_id, '00000000-0000-0000-0000-000000000000'::uuid)), property_type, listing_type, bedroom_band, budget_band);
ALTER TABLE analytics_search_daily ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS listing_status_events (
  id bigserial PRIMARY KEY,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  price_at_change numeric,
  at timestamptz NOT NULL DEFAULT now(),
  approx boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS listing_status_events_at ON listing_status_events (at);
CREATE INDEX IF NOT EXISTS listing_status_events_listing ON listing_status_events (listing_id, at);
ALTER TABLE listing_status_events ENABLE ROW LEVEL SECURITY;

-- Price history: the first price when a unit is created, and every later change. A writer that already recorded the same price
-- as the latest row (the price-sheet writer) is not recorded twice; a first change of an old unit also keeps the price it had.
CREATE OR REPLACE FUNCTION analytics_listing_price() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  last_price numeric;
  has_rows boolean;
BEGIN
  IF NEW.price_value IS NULL OR NEW.price_value <= 0 OR NEW.price_value >= 100000000000000 THEN RETURN NULL; END IF;
  SELECT price INTO last_price FROM listing_prices WHERE listing_id = NEW.id ORDER BY changed_at DESC, id DESC LIMIT 1;
  has_rows := FOUND;
  IF has_rows AND last_price = round(NEW.price_value) THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NOT has_rows AND OLD.price_value IS NOT NULL AND OLD.price_value > 0 AND OLD.price_value < 100000000000000 THEN
    INSERT INTO listing_prices (agency_id, listing_id, price, source, changed_at)
    VALUES (NEW.agency_id, NEW.id, round(OLD.price_value), 'edit', COALESCE(OLD.confirmed_at, OLD.created_at, now()) - interval '1 second');
  END IF;
  INSERT INTO listing_prices (agency_id, listing_id, price, source, changed_at)
  VALUES (NEW.agency_id, NEW.id, round(NEW.price_value), 'edit', now());
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS listings_analytics_price_ins ON listings;
CREATE TRIGGER listings_analytics_price_ins AFTER INSERT ON listings
  FOR EACH ROW EXECUTE FUNCTION analytics_listing_price();
DROP TRIGGER IF EXISTS listings_analytics_price_upd ON listings;
CREATE TRIGGER listings_analytics_price_upd AFTER UPDATE OF price_value ON listings
  FOR EACH ROW WHEN (OLD.price_value IS DISTINCT FROM NEW.price_value)
  EXECUTE FUNCTION analytics_listing_price();

-- Status history: one row per change of status, or when the unit is deleted (deleted_at set).
CREATE OR REPLACE FUNCTION analytics_listing_status() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO listing_status_events (agency_id, listing_id, from_status, to_status, price_at_change)
    VALUES (NEW.agency_id, NEW.id, OLD.status, NEW.status, NEW.price_value);
  ELSIF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    INSERT INTO listing_status_events (agency_id, listing_id, from_status, to_status, price_at_change)
    VALUES (NEW.agency_id, NEW.id, NEW.status, 'deleted', NEW.price_value);
  END IF;
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS listings_analytics_status ON listings;
CREATE TRIGGER listings_analytics_status AFTER UPDATE OF status, deleted_at ON listings
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL))
  EXECUTE FUNCTION analytics_listing_status();

-- Existing sold units: one event at the last update, flagged approximate. Nothing is invented for other statuses.
INSERT INTO listing_status_events (agency_id, listing_id, from_status, to_status, price_at_change, at, approx)
SELECT l.agency_id, l.id, NULL, 'sold', l.price_value, l.updated_at, true
  FROM listings l
 WHERE l.status = 'sold' AND NOT EXISTS (SELECT 1 FROM listing_status_events e WHERE e.listing_id = l.id);
