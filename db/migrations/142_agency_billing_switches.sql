-- 142: Agency owner delegation switches for manager billing.
-- Off by default: only the agency owner can renew plans or buy credits until explicitly enabled.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS manager_can_renew_plan boolean NOT NULL DEFAULT false;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS manager_can_buy_credits boolean NOT NULL DEFAULT false;
