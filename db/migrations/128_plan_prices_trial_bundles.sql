-- 128: Explicit price table per plan and period, the trial as its own plan row, new credit bundle prices.
-- credit_plans.prices is { "<months>": price in EGP }: a period missing from it is not sold for that plan (Agency has no
-- monthly price; Enterprise is contact-only, its prices are kept for reference and the row stays inactive).
-- 'trial' is the 14-day self sign-up plan: 1 seat, 50 units, 80 credits, price 0, never sold (inactive).
-- Bundles: 200 = 99, 500 = 229, 1,000 = 399 and the new Agency Pack of 2,500 = 899.
ALTER TABLE credit_plans ADD COLUMN IF NOT EXISTS prices jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE credit_plans SET prices = '{"1": 199, "6": 1075, "12": 1990}'::jsonb WHERE id = 'solo';
UPDATE credit_plans SET prices = '{"1": 599, "6": 3235, "12": 5990}'::jsonb WHERE id = 'team';
UPDATE credit_plans SET prices = '{"1": 1790, "6": 9666, "12": 17900}'::jsonb WHERE id = 'office';
UPDATE credit_plans SET prices = '{"6": 16146, "12": 29900}'::jsonb WHERE id = 'agency';
UPDATE credit_plans SET prices = '{"6": 29900, "12": 53900}'::jsonb WHERE id = 'enterprise';

INSERT INTO credit_plans (id, name_ar, name_en, price_egp, seats, units, credits, sort, active, prices) VALUES
  ('trial', 'تجربة', 'Trial', 0, 1, 50, 80, 0, false, '{}'::jsonb)
ON CONFLICT (id) DO UPDATE SET name_ar = EXCLUDED.name_ar, name_en = EXCLUDED.name_en, price_egp = 0, seats = 1, units = 50,
  credits = 80, active = false, prices = '{}'::jsonb, updated_at = now();

UPDATE credit_bundles SET price_egp = 99 WHERE id = 'small' AND credits = 200;
UPDATE credit_bundles SET price_egp = 229 WHERE id = 'medium' AND credits = 500;
UPDATE credit_bundles SET price_egp = 399 WHERE id = 'large' AND credits = 1000;
INSERT INTO credit_bundles (id, name_ar, name_en, price_egp, credits, sort, active) VALUES
  ('agency', 'باقة الشركات', 'Agency Pack', 899, 2500, 4, true)
ON CONFLICT (id) DO UPDATE SET name_ar = EXCLUDED.name_ar, name_en = EXCLUDED.name_en, price_egp = EXCLUDED.price_egp,
  credits = EXCLUDED.credits, active = true, updated_at = now();
