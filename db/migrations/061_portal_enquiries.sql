-- 061: portal enquiries (Bayut, Dubizzle, Nawy). A new-enquiry message a manager or owner forwards to the bot is kept
-- here (portal, client name, link, listing number) until a manager adds the phone and assigns a broker; then it becomes
-- a lead with the portal as its source. Owner-only switch for the alerts (agencies.portal_alerts).
ALTER TABLE listings ADD COLUMN IF NOT EXISTS portal_listing_no text CHECK (portal_listing_no IS NULL OR length(portal_listing_no) BETWEEN 4 AND 20);
CREATE UNIQUE INDEX IF NOT EXISTS listings_portal_no_idx ON listings (agency_id, portal_listing_no) WHERE portal_listing_no IS NOT NULL;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS portal_alerts boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS portal_enquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  portal text NOT NULL CHECK (length(portal) BETWEEN 1 AND 40),
  client_name text CHECK (client_name IS NULL OR length(client_name) <= 120),
  link text NOT NULL CHECK (length(link) <= 1000),
  listing_no text CHECK (listing_no IS NULL OR length(listing_no) BETWEEN 4 AND 20),
  created_by_broker_id uuid REFERENCES brokers(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'assigned')),
  phone_e164 text CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  assigned_broker_id uuid REFERENCES brokers(id) ON DELETE SET NULL,
  merged boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS portal_enquiries_agency_idx ON portal_enquiries (agency_id, created_at DESC);
ALTER TABLE portal_enquiries ENABLE ROW LEVEL SECURITY;
