-- 079: developer profile (free text, all optional). Ask reads these; brokers see them on the developer page; clients never do.
-- Each field is capped at 2,000 characters. Contact and internal notes stay as they were (managers only).
ALTER TABLE developers ADD COLUMN IF NOT EXISTS about text CHECK (about IS NULL OR length(about) <= 2000);
ALTER TABLE developers ADD COLUMN IF NOT EXISTS past_projects text CHECK (past_projects IS NULL OR length(past_projects) <= 2000);
ALTER TABLE developers ADD COLUMN IF NOT EXISTS delivery_record text CHECK (delivery_record IS NULL OR length(delivery_record) <= 2000);
ALTER TABLE developers ADD COLUMN IF NOT EXISTS usual_payment_terms text CHECK (usual_payment_terms IS NULL OR length(usual_payment_terms) <= 2000);
ALTER TABLE developers ADD COLUMN IF NOT EXISTS warnings text CHECK (warnings IS NULL OR length(warnings) <= 2000);
