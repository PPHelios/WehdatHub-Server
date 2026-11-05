-- 078: the agency's notification policy (owner and manager locks, team defaults). Per kind: on, channel, frequency, lock.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS notify_policy jsonb NOT NULL DEFAULT '{}'::jsonb;

-- The notification reasons: a batched notification (held for its time slot) and one the agency's policy switched off.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_reason_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_reason_check
  CHECK (reason = ANY (ARRAY['chosen', 'fallback', 'no_credits', 'window_closed', 'quiet_hours', 'merged', 'no_push', 'not_linked', 'switched_off', 'batched', 'policy_off']));
