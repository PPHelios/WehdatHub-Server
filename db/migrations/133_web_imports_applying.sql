-- 133: Excel import Apply runs in the background (status 'applying'): a plan moves ready -> applying -> ready (rows left) or applied.
-- Roll back: set any 'applying' plan to 'ready' first, then restore the old CHECK (processing, ready, applied, failed).
ALTER TABLE web_imports DROP CONSTRAINT IF EXISTS web_imports_status_check;
ALTER TABLE web_imports ADD CONSTRAINT web_imports_status_check CHECK (status IN ('processing', 'ready', 'applying', 'applied', 'failed'));
