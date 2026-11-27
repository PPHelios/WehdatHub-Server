-- 147_deals_market_area_snapshot.sql — Snapshot market and canonical area on deals at closing time
-- so historical deal reports never drift when a linked unit is later edited or deleted.

ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS market text,
  ADD COLUMN IF NOT EXISTS area_key text,
  ADD COLUMN IF NOT EXISTS area_label text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'deals_market_check'
  ) THEN
    ALTER TABLE public.deals
      ADD CONSTRAINT deals_market_check CHECK (market IS NULL OR market IN ('primary', 'resale'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_deals_agency_market
  ON public.deals (agency_id, market)
  WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS idx_deals_agency_area
  ON public.deals (agency_id, area_key)
  WHERE status <> 'cancelled';

UPDATE public.deals d
   SET market = COALESCE(
         d.market,
         CASE
           WHEN l.market IN ('primary', 'resale') THEN l.market
           WHEN l.inventory_type = 'primary_unit'
             OR COALESCE(l.details->>'catalogue', '') = 'true'
             OR COALESCE(l.is_primary_developer, false) = true THEN 'primary'
           WHEN l.id IS NOT NULL THEN 'resale'
           WHEN EXISTS (
             SELECT 1 FROM public.commissions c
              WHERE c.deal_id = d.id AND c.status <> 'cancelled'
           ) THEN 'primary'
           ELSE NULL
         END
       ),
       area_key = COALESCE(
         d.area_key,
         NULLIF(a.name_key, ''),
         NULLIF(mpa.name_key, ''),
         NULLIF(l.area_key, ''),
         NULLIF((public.match_place('area', concat_ws(' ', l.district, l.city, l.location, l.compound))).key, '')
       ),
       area_label = COALESCE(
         d.area_label,
         NULLIF(a.name_en, ''),
         NULLIF(mpa.name_en, ''),
         NULLIF(BTRIM(l.district), ''),
         NULLIF(BTRIM(l.city), '')
       )
  FROM (SELECT id, listing_id, market, area_key, area_label FROM public.deals) src
  LEFT JOIN public.listings l ON l.id = src.listing_id
  LEFT JOIN public.areas a ON a.id = l.area_id
  LEFT JOIN public.map_places mp ON mp.id = l.place_id
  LEFT JOIN public.areas mpa ON mpa.id = mp.area_id
 WHERE d.id = src.id
   AND (d.market IS NULL OR d.area_key IS NULL OR d.area_label IS NULL);
