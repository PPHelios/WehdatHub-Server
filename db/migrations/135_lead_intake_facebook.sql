-- 135: lead intake goes direct to Facebook Lead Ads (no URL, no middleman). The owner pastes a Page access token per
-- agency; the app subscribes the Page to the app's leadgen webhook and fetches each lead from Graph. The token is
-- never shown again (the page keeps only its last 4 characters in token_hint) and is cleared when the intake is stopped.
-- Old URL intakes keep their rows (and their log); their hash is no longer used.
ALTER TABLE lead_intakes ALTER COLUMN token_hash DROP NOT NULL;
ALTER TABLE lead_intakes ALTER COLUMN token_hint DROP NOT NULL;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS page_id text;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS page_name text;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS page_token text;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS subscribed_at timestamptz;
-- One active intake per Facebook Page (a stopped one frees the Page).
CREATE UNIQUE INDEX IF NOT EXISTS lead_intakes_page_idx ON lead_intakes (page_id) WHERE page_id IS NOT NULL AND revoked_at IS NULL;
-- Old URL intakes can no longer receive anything.
UPDATE lead_intakes SET revoked_at = now() WHERE page_id IS NULL AND revoked_at IS NULL;
ALTER TABLE lead_intakes ENABLE ROW LEVEL SECURITY;
