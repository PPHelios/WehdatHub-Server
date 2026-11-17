-- 126: New plan table. Free 1 seat / 50 units / 80 credits; Solo 1 / 1,000 / 400 at 199; Team 5 / 5,000 / 2,000 at 599;
-- Office 15 / no unit cap / 6,000 at 1,790; Agency 25 / no unit cap / 10,000 at 2,990 (sold 6 or 12 months up front);
-- Enterprise 50 / no unit cap / 20,000 (contact form; not on sale). "No unit cap" is 1000000 (the page shows "Unlimited").
INSERT INTO credit_plans (id, name_ar, name_en, price_egp, seats, units, credits, sort, active) VALUES
  ('free', 'مجاني', 'Free', 0, 1, 50, 80, 0, true),
  ('solo', 'سولو', 'Solo', 199, 1, 1000, 400, 1, true),
  ('team', 'فريق', 'Team', 599, 5, 5000, 2000, 2, true),
  ('office', 'مكتب', 'Office', 1790, 15, 1000000, 6000, 3, true),
  ('agency', 'شركة', 'Agency', 2990, 25, 1000000, 10000, 4, true),
  ('enterprise', 'مؤسسات', 'Enterprise', 5390, 50, 1000000, 20000, 5, false)
ON CONFLICT (id) DO UPDATE SET name_ar = EXCLUDED.name_ar, name_en = EXCLUDED.name_en, price_egp = EXCLUDED.price_egp,
  seats = EXCLUDED.seats, units = EXCLUDED.units, credits = EXCLUDED.credits, sort = EXCLUDED.sort, active = EXCLUDED.active, updated_at = now();

-- NCH moves to the Agency plan (25 seats). A pilot agency now follows its own plan (see services/billing.js effectivePlan).
UPDATE agencies SET plan = 'agency' WHERE name ILIKE 'NCH%' OR slug ILIKE 'nch%';
