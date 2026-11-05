-- 077: lead-time reminders for calls and viewings. Each reminder a broker asked for (30 min, 1 hour, 2 hours before) is sent
-- once per follow-up time: follow_up_reminded_steps holds the lead times already sent for the current time. Changing the
-- follow-up time, its status or its broker clears the list (trigger), so a moved follow-up is reminded again. Leads reminded before this
-- migration count as reminded at one hour, the old single reminder.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_reminded_steps integer[] NOT NULL DEFAULT '{}';

UPDATE leads SET follow_up_reminded_steps = ARRAY[60] WHERE follow_up_reminded_at IS NOT NULL AND follow_up_reminded_steps = '{}';

CREATE OR REPLACE FUNCTION leads_reset_reminder_steps() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.next_follow_up_at IS DISTINCT FROM OLD.next_follow_up_at OR NEW.follow_up_status IS DISTINCT FROM OLD.follow_up_status
     OR NEW.assigned_broker_id IS DISTINCT FROM OLD.assigned_broker_id THEN
    NEW.follow_up_reminded_steps := '{}';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_leads_reset_reminder_steps ON leads;
CREATE TRIGGER trg_leads_reset_reminder_steps BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION leads_reset_reminder_steps();
