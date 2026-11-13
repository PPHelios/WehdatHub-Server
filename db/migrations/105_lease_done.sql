-- 105: a lease reminder is acted on. The broker (or a manager) marks the lease handled (renewed, tenant leaving, or to re-list); reminders then stop.
ALTER TABLE leases ADD COLUMN IF NOT EXISTS done_at timestamptz;
ALTER TABLE leases ADD COLUMN IF NOT EXISTS done_kind text CHECK (done_kind IN ('renewed', 'leaving', 'relist'));
