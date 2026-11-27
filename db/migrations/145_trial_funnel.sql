-- Keep an anonymous signup cohort after the temporary Telegram verification record is purged.
CREATE TABLE trial_funnel (
  signup_id bigint PRIMARY KEY,
  tier text NOT NULL CHECK (tier IN ('solo', 'team')),
  offered_days integer NOT NULL CHECK (offered_days > 0),
  offered_credits integer NOT NULL CHECK (offered_credits >= 0),
  started_at timestamptz NOT NULL,
  telegram_opened_at timestamptz,
  verified_at timestamptz,
  agency_id uuid REFERENCES agencies(id) ON DELETE SET NULL,
  granted_days integer CHECK (granted_days > 0),
  granted_credits integer CHECK (granted_credits >= 0)
);
CREATE INDEX trial_funnel_started ON trial_funnel (started_at);
CREATE INDEX trial_funnel_agency ON trial_funnel (agency_id);
ALTER TABLE trial_funnel ENABLE ROW LEVEL SECURITY;
