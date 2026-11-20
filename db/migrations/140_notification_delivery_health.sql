-- 140: notification delivery health. A failed send is retried a few times (attempts, next try in deliver_after) and, when it
-- still fails, is recorded as 'failed' with the error (last_error) instead of looking like a plain 'skipped'.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS last_error text;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_channel_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_channel_check CHECK (channel IN ('whatsapp', 'webpush', 'inbox', 'telegram', 'apppush'));

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_reason_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_reason_check
  CHECK (reason = ANY (ARRAY['chosen', 'fallback', 'no_credits', 'window_closed', 'quiet_hours', 'merged', 'no_push', 'not_linked', 'switched_off', 'batched', 'policy_off', 'retry', 'send_failed', 'recovered']));

-- Rows left 'pending' (the server stopped between saving and sending) are found by the sweep in deliverDue.
CREATE INDEX IF NOT EXISTS idx_notifications_pending ON notifications (created_at) WHERE status = 'pending';
-- Delivery stats by day and kind.
CREATE INDEX IF NOT EXISTS idx_notifications_status_created ON notifications (created_at, status);
