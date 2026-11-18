-- 131: Self-serve trial (Phase 5).
--  * trial_claims: one free trial per phone number AND per Telegram account, ever. Rows are never deleted and survive the
--    agency (agency_id is set null if the agency is removed), so a deactivated or expired agency cannot restart a trial.
--  * trial_signups: a pending self sign-up waiting for the Telegram contact share. Only the hash of the start token is
--    stored; `attempts` counts wrong contact shares (5 max); expires after 15 minutes; used_at is set once it completed.
--  * demo_requests.kind: 'trial' (the old "try it" form) or 'demo' (Book a Live Demo / Contact Sales for offices);
--    pilot_agency_id links a demo request to the guided pilot the owner created from it.
CREATE TABLE IF NOT EXISTS trial_claims (
  id bigserial PRIMARY KEY,
  phone_e164 text NOT NULL CHECK (length(phone_e164) <= 20),
  telegram_id bigint NOT NULL,
  agency_id uuid REFERENCES agencies(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT trial_claims_phone_key UNIQUE (phone_e164),
  CONSTRAINT trial_claims_telegram_key UNIQUE (telegram_id)
);
ALTER TABLE trial_claims ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS trial_signups (
  id bigserial PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  phone_e164 text NOT NULL CHECK (length(phone_e164) <= 20),
  agency_name text NOT NULL CHECK (length(agency_name) BETWEEN 1 AND 120),
  owner_name text NOT NULL CHECK (length(owner_name) BETWEEN 1 AND 80),
  lang text NOT NULL DEFAULT 'ar' CHECK (lang IN ('ar', 'en')),
  referred_by uuid REFERENCES agencies(id) ON DELETE SET NULL,
  telegram_id bigint,
  chat_id bigint,
  attempts smallint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS trial_signups_telegram_idx ON trial_signups (telegram_id) WHERE used_at IS NULL;
ALTER TABLE trial_signups ENABLE ROW LEVEL SECURITY;

ALTER TABLE demo_requests ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'trial';
ALTER TABLE demo_requests DROP CONSTRAINT IF EXISTS demo_requests_kind_check;
ALTER TABLE demo_requests ADD CONSTRAINT demo_requests_kind_check CHECK (kind IN ('trial', 'demo'));
ALTER TABLE demo_requests ADD COLUMN IF NOT EXISTS pilot_agency_id uuid REFERENCES agencies(id) ON DELETE SET NULL;
