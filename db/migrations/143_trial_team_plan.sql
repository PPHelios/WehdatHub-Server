INSERT INTO credit_plans (id, name_ar, name_en, price_egp, seats, units, credits, sort, active, prices)
VALUES ('trial_team', 'تجربة فريق', 'Team Trial', 0, 5, 50, 200, 0, false, '{}'::jsonb);

ALTER TABLE trial_signups ADD COLUMN tier text NOT NULL DEFAULT 'solo'
  CHECK (tier IN ('solo', 'team'));
