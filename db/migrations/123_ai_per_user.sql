-- 123: Per-person AI credit limits (spec-server.md section 4). Additive only; every agency starts in the shared pool.
-- ai_usage_mode: 'pool' (default, one pool for the agency) or 'per_user' (each person also has a monthly allowance).
-- ai_user_default_credits: the allowance everyone gets in per_user mode (null = no personal limit).
-- brokers.ai_user_credits: one person's own allowance (null = the default). The pool still caps the agency total.
-- manager_can_edit_ai_settings: the agency owner lets managers change these settings (off by default).
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS ai_usage_mode text NOT NULL DEFAULT 'pool';
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS ai_user_default_credits integer;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS manager_can_edit_ai_settings boolean NOT NULL DEFAULT false;
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS ai_user_credits integer;
ALTER TABLE agencies DROP CONSTRAINT IF EXISTS agencies_ai_usage_mode_check;
ALTER TABLE agencies ADD CONSTRAINT agencies_ai_usage_mode_check CHECK (ai_usage_mode IN ('pool', 'per_user'));
ALTER TABLE agencies DROP CONSTRAINT IF EXISTS agencies_ai_user_default_credits_check;
ALTER TABLE agencies ADD CONSTRAINT agencies_ai_user_default_credits_check CHECK (ai_user_default_credits IS NULL OR ai_user_default_credits >= 0);
ALTER TABLE brokers DROP CONSTRAINT IF EXISTS brokers_ai_user_credits_check;
ALTER TABLE brokers ADD CONSTRAINT brokers_ai_user_credits_check CHECK (ai_user_credits IS NULL OR ai_user_credits >= 0);
