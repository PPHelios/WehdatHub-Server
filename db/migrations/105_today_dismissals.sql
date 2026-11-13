-- 105: a person can dismiss a card on Today (a lease reminder). The key names the card and carries the lease end date, so a renewed lease shows again.
CREATE TABLE IF NOT EXISTS today_dismissals (
  broker_id  UUID NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  key        TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (broker_id, kind, key)
);
ALTER TABLE today_dismissals ENABLE ROW LEVEL SECURITY;
