-- 130: Mid-cycle upgrades, price lock and the hidden extra-seats override.
--  * payments.kind gains 'upgrade' (a pro-rated move to a higher plan; `plan` is the target plan, paid_until is not touched)
--    and 'extra_seats' (written already confirmed by the platform owner; `seats` = how many, `months` = remaining months billed).
--  * payments.detail keeps the basis of the amount (current plan, per-month prices, remaining days, lock used) for audit.
--  * agencies.locked_prices / lock_until: snapshot { plan: { months: EGP } } written when a 12-month payment is confirmed;
--    requestPayment uses it while lock_until is in the future. founding_partner: flag set by the platform owner (first 20).
--  * agencies.extra_seats: 0..4 seats added mid-contract (+400 credits a month each); reset to 0 when a new paid period
--    starts after expiry.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS locked_prices jsonb;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS lock_until timestamptz;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS founding_partner boolean NOT NULL DEFAULT false;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS extra_seats smallint NOT NULL DEFAULT 0;
ALTER TABLE agencies DROP CONSTRAINT IF EXISTS agencies_extra_seats_check;
ALTER TABLE agencies ADD CONSTRAINT agencies_extra_seats_check CHECK (extra_seats BETWEEN 0 AND 4);

ALTER TABLE payments ADD COLUMN IF NOT EXISTS seats smallint;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS detail jsonb;

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_kind_check;
ALTER TABLE payments ADD CONSTRAINT payments_kind_check CHECK (kind IN ('plan', 'voice_pack', 'credit_bundle', 'upgrade', 'extra_seats'));

-- The old "(kind = 'plan') = (plan IS NOT NULL)" check has no fixed name: find it by its text.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'payments'::regclass AND contype = 'c'
              AND (pg_get_constraintdef(oid) ILIKE '%kind = ''plan''%' OR pg_get_constraintdef(oid) ILIKE '%months >= 1%' OR pg_get_constraintdef(oid) ILIKE '%months%BETWEEN%')
  LOOP
    EXECUTE format('ALTER TABLE payments DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE payments ADD CONSTRAINT payments_plan_kind_check CHECK ((kind IN ('plan', 'upgrade')) = (plan IS NOT NULL));
ALTER TABLE payments ADD CONSTRAINT payments_months_range_check CHECK (months BETWEEN 1 AND 60);
ALTER TABLE payments ADD CONSTRAINT payments_seats_check CHECK (seats IS NULL OR seats BETWEEN 1 AND 4);
