ALTER TABLE agencies ADD COLUMN trial_ai_credits integer CHECK (trial_ai_credits >= 0);
