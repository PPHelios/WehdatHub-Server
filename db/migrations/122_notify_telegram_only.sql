-- 122: WhatsApp is no longer a notification channel (plan 12b). A person's saved "whatsapp" choice is dropped, so their
-- default applies (Telegram and website when Telegram is linked, else website and app push); an agency policy that
-- forced "whatsapp" loses that channel (people choose). Old notification rows keep their history. Safe to run twice.
UPDATE brokers SET notify_prefs = jsonb_set(notify_prefs, '{channels}',
  COALESCE((SELECT jsonb_object_agg(e.k, e.v) FROM jsonb_each(notify_prefs->'channels') AS e(k, v) WHERE e.v <> '"whatsapp"'::jsonb), '{}'::jsonb))
 WHERE jsonb_typeof(notify_prefs->'channels') = 'object'
   AND EXISTS (SELECT 1 FROM jsonb_each(notify_prefs->'channels') AS e(k, v) WHERE e.v = '"whatsapp"'::jsonb);

UPDATE agencies SET notify_policy = (SELECT jsonb_object_agg(e.k, CASE WHEN jsonb_typeof(e.v) = 'object' AND e.v->>'channel' = 'whatsapp' THEN e.v - 'channel' ELSE e.v END) FROM jsonb_each(notify_policy) AS e(k, v))
 WHERE jsonb_typeof(notify_policy) = 'object'
   AND EXISTS (SELECT 1 FROM jsonb_each(notify_policy) AS e(k, v) WHERE jsonb_typeof(e.v) = 'object' AND e.v->>'channel' = 'whatsapp');
