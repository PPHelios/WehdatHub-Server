-- 129: Platform owner can extend an agency's grace period by hand (+3 / +7 days). The expiry ladder itself is derived
-- from paid_until / trial_ends_at (services/billing.js effectivePlan); this is the only stored piece: the later of the
-- normal grace end and this timestamp is when grace ends. Cleared when the agency pays.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS grace_extra_until timestamptz;
