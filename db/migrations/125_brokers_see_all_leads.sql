-- 125: the agency switch "brokers see all leads" (agencies.crm_settings.brokers_see_all_leads, see services/leadScope.js).
-- A missing key means ON for new agencies (Haytham, 2026-11-15). Agencies that exist today keep what they have now:
-- brokers see only their own leads, until the agency owner turns the switch on. Idempotent.
UPDATE agencies
   SET crm_settings = coalesce(crm_settings, '{}'::jsonb) || '{"brokers_see_all_leads": false}'::jsonb
 WHERE NOT (coalesce(crm_settings, '{}'::jsonb) ? 'brokers_see_all_leads');
