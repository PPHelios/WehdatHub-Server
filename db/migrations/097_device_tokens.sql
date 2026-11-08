-- 097: the phones that signed in to the mobile app and agreed to alerts (one row per app install, Firebase token).
CREATE TABLE IF NOT EXISTS device_tokens (
  id bigserial PRIMARY KEY,
  broker_id uuid NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE CHECK (length(token) BETWEEN 20 AND 4096),
  platform text NOT NULL CHECK (platform IN ('android', 'ios')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_ok_at timestamptz,
  failed_count integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_broker ON device_tokens (broker_id);
ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;
