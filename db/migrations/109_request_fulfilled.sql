-- A client request (a saved search with alerts, tied to a lead or not) is fulfilled when a match is sent to the
-- client or the broker marks it. A fulfilled request stops alerting and moves to the Fulfilled tab.
ALTER TABLE saved_searches ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz;
