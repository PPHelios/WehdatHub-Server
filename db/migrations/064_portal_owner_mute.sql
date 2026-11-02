-- 064: the owner's mute for portal enquiry alerts is for the owner himself only (kept in brokers.notify_prefs.portal_muted),
-- so the agency-wide column from 061 goes. Nothing was ever stored in it that matters: the feature is new.
ALTER TABLE agencies DROP COLUMN IF EXISTS portal_alerts;

-- lead_requests (062) was created without row-level security; every public table has it (the lockdown test checks).
ALTER TABLE lead_requests ENABLE ROW LEVEL SECURITY;
