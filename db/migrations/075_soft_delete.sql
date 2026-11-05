-- 075: soft delete. A deleted unit stays for 10 days (managers and the owner can restore it), then its photos and private
-- details are removed. Its reference facts (price, area, type, place, dates) move to unit_reference and stay for prices and
-- metrics. Deleted units never appear in search, sweeps, client links or any count: every read asks for active, sold or
-- archived explicitly. The unit's code stays reserved while it is deleted (the row still exists).
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_status_check;
ALTER TABLE listings ADD CONSTRAINT listings_status_check
  CHECK (status = ANY (ARRAY['draft'::text, 'active'::text, 'sold'::text, 'archived'::text, 'deleted'::text]));
ALTER TABLE listings ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES brokers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS listings_deleted_idx ON listings (agency_id, deleted_at) WHERE status = 'deleted';

CREATE TABLE IF NOT EXISTS unit_reference (
  id bigserial PRIMARY KEY,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  code text NOT NULL,
  listing_type text,
  market text,
  property_type text,
  compound text,
  compound_en text,
  district text,
  city text,
  area_value numeric,
  bedrooms integer,
  bathrooms integer,
  price_value numeric,
  currency text,
  finishing text,
  furnishing text,
  delivery_year integer,
  created_at timestamptz,
  deleted_at timestamptz NOT NULL,
  purged_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS unit_reference_agency_idx ON unit_reference (agency_id, purged_at DESC);
ALTER TABLE unit_reference ENABLE ROW LEVEL SECURITY;
