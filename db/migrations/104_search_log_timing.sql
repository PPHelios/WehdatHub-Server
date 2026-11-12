-- Search log: how long each search took and which model read it (all channels, incl. the phone app).
ALTER TABLE search_log ADD COLUMN IF NOT EXISTS parse_ms INTEGER;   -- time to read the request (AI or quick reader)
ALTER TABLE search_log ADD COLUMN IF NOT EXISTS db_ms    INTEGER;   -- time of the database search
ALTER TABLE search_log ADD COLUMN IF NOT EXISTS total_ms INTEGER;   -- whole search as the broker waited for it
ALTER TABLE search_log ADD COLUMN IF NOT EXISTS model    TEXT;      -- model that read it (local_parser when none)
CREATE INDEX IF NOT EXISTS search_log_slow ON search_log (created_at DESC) WHERE total_ms > 5000;
