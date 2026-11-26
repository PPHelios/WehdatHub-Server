-- Allow WhatsApp-verified self-serve trials to record a claim before Telegram is linked.
ALTER TABLE trial_claims ALTER COLUMN telegram_id DROP NOT NULL;
