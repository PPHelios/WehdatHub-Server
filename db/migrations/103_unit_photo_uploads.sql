-- 103: photos uploaded straight to storage while a unit is being added or edited. The server hands out a one-time upload link
-- per photo (signed, 2 hours) and writes a row here; saving the unit names the photo keys, and the row is marked attached in the
-- same transaction as the unit. Photos never attached are removed with their small copy after 24 hours (daily privacy job);
-- attached rows are forgotten after 7 days.
-- Roll back: DROP TABLE unit_photo_uploads;
CREATE TABLE IF NOT EXISTS unit_photo_uploads (
  key text PRIMARY KEY CHECK (length(key) BETWEEN 8 AND 64),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  broker_id uuid NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
  path text NOT NULL,
  thumb_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  attached_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_unit_photo_uploads_state ON unit_photo_uploads (attached_at, created_at);
CREATE INDEX IF NOT EXISTS idx_unit_photo_uploads_broker ON unit_photo_uploads (broker_id, created_at DESC);
ALTER TABLE unit_photo_uploads ENABLE ROW LEVEL SECURITY;
