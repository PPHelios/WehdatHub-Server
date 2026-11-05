-- 078: plan rules per project and the exception flag on a payment plan (custom plan calculator, step 1).
-- projects.plan_rules holds the developer's limits as data: lowest down payment, longest term, allowed frequencies,
-- highest discount, maintenance, and optional fees (garage, club...) each with an amount and when it is due.
-- Every field is optional; a project with no rules shows "no rules set" in the calculator.
-- project_plans.exception_status: 'none' (inside the rules), 'needs_approval' (outside them, broker only), 'approved'
-- (a manager approved it; only approved plans reach client files).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS plan_rules jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE project_plans ADD COLUMN IF NOT EXISTS exception_status text NOT NULL DEFAULT 'none'
  CHECK (exception_status IN ('none', 'needs_approval', 'approved'));
