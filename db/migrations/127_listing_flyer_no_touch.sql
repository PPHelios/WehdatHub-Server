-- 127: Making a unit's flyer (flyer_cache, flyer_url, flyer WhatsApp media) no longer counts as updating the unit. Before,
-- every UPDATE set updated_at = now(), so any broker sharing a flyer made an old unit look freshly updated (stale filters,
-- "units to check" and sort order use updated_at). QA round 3, finding 69.
-- An update that sets updated_at itself keeps that value; one that changes only flyer columns keeps the old updated_at;
-- everything else gets now(), as before. Generated columns (code_norm) are left out: they are null in a BEFORE trigger.
CREATE OR REPLACE FUNCTION public.listings_touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  skip text[] := ARRAY['flyer_cache', 'flyer_url', 'flyer_wa_media_id', 'flyer_wa_media_at', 'updated_at', 'search_document', 'code_norm'];
BEGIN
  IF NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - skip) = (to_jsonb(OLD) - skip) THEN
    NEW.updated_at = OLD.updated_at;
  ELSE
    NEW.updated_at = NOW();
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_update_listings_timestamp ON public.listings;
CREATE TRIGGER trg_update_listings_timestamp BEFORE UPDATE ON public.listings FOR EACH ROW EXECUTE FUNCTION listings_touch_updated_at();
