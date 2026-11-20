-- 138: market analytics aggregate tables and the per-agency switch. Rows hold bands, counts and medians only: no phone, name,
-- note, unit code, address, owner or photo. A market cell is written only when it covers enough agencies and rows
-- (domain/analyticsPrivacy.js). Only the service reads these tables (RLS on, no policy).
-- Roll back: DROP TABLE analytics_market_daily, analytics_funnel_monthly; ALTER TABLE agencies DROP COLUMN analytics_enabled;

ALTER TABLE agencies ADD COLUMN IF NOT EXISTS analytics_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS analytics_market_daily (
  day date NOT NULL,
  area_id uuid,
  property_type text NOT NULL DEFAULT 'all',
  listing_type text NOT NULL DEFAULT 'all',
  bedroom_band text NOT NULL DEFAULT 'all',
  listings_active integer NOT NULL DEFAULT 0,
  new_listings integer NOT NULL DEFAULT 0,
  removed_listings integer NOT NULL DEFAULT 0,
  price_m2_p25 numeric,
  price_m2_p50 numeric,
  price_m2_p75 numeric,
  price_p50 numeric,
  sold_count integer NOT NULL DEFAULT 0,
  median_days_to_close numeric,
  asking_vs_closed_pct numeric,
  agencies_n integer NOT NULL,
  rows_n integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS analytics_market_daily_cell
  ON analytics_market_daily (day, (COALESCE(area_id, '00000000-0000-0000-0000-000000000000'::uuid)), property_type, listing_type, bedroom_band);
ALTER TABLE analytics_market_daily ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS analytics_funnel_monthly (
  month date NOT NULL,
  agency_id uuid REFERENCES agencies(id) ON DELETE CASCADE,
  leads integer NOT NULL DEFAULT 0,
  contacted integer NOT NULL DEFAULT 0,
  viewings integer NOT NULL DEFAULT 0,
  deals integer NOT NULL DEFAULT 0,
  lost integer NOT NULL DEFAULT 0,
  median_first_response_minutes numeric,
  by_source jsonb NOT NULL DEFAULT '{}'::jsonb,
  lost_reasons jsonb NOT NULL DEFAULT '{}'::jsonb,
  rates jsonb NOT NULL DEFAULT '{}'::jsonb,
  agencies_n integer
);
CREATE UNIQUE INDEX IF NOT EXISTS analytics_funnel_monthly_cell
  ON analytics_funnel_monthly (month, (COALESCE(agency_id, '00000000-0000-0000-0000-000000000000'::uuid)));
ALTER TABLE analytics_funnel_monthly ENABLE ROW LEVEL SECURITY;
