-- 148: Phase 4 Coached Accountability deduplication timestamps on leads.
-- Prevents overlapping notifications between SLA midway warnings, 24h untouched nudges,
-- 2h post-viewing outcome check-ins, and 2h opened-link silence nudges.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS sla_warning_sent_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS post_viewing_nudged_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS link_silence_nudged_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_leads_sla_warning
  ON leads (response_due_at)
  WHERE stage = 'new' AND last_contact_at IS NULL AND response_due_at IS NOT NULL AND sla_warning_sent_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_leads_post_viewing_nudge
  ON leads (next_follow_up_at)
  WHERE follow_up_status = 'open' AND follow_up_kind = 'viewing' AND post_viewing_nudged_at IS NULL;

CREATE OR REPLACE FUNCTION leads_reset_reminder_steps() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.next_follow_up_at IS DISTINCT FROM OLD.next_follow_up_at
     OR NEW.follow_up_status IS DISTINCT FROM OLD.follow_up_status
     OR NEW.follow_up_kind IS DISTINCT FROM OLD.follow_up_kind
     OR NEW.assigned_broker_id IS DISTINCT FROM OLD.assigned_broker_id THEN
    NEW.follow_up_reminded_steps := '{}';
    NEW.post_viewing_nudged_at := NULL;
  END IF;
  IF NEW.response_due_at IS DISTINCT FROM OLD.response_due_at
     OR NEW.assigned_broker_id IS DISTINCT FROM OLD.assigned_broker_id THEN
    NEW.sla_warning_sent_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
