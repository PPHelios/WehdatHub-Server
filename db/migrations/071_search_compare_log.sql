-- 070: the search log keeps how the quick reader and the AI differed on each search, which close spellings the quick reader
-- accepted, which unknown words the bot asked about, and why the AI could not answer (so the review dashboard can list them).
ALTER TABLE search_log ADD COLUMN IF NOT EXISTS disagree TEXT[] NOT NULL DEFAULT '{}';   -- filters the two readings read differently
ALTER TABLE search_log ADD COLUMN IF NOT EXISTS guesses  JSONB;                           -- [{ typed, as }] close spellings read as a known place
ALTER TABLE search_log ADD COLUMN IF NOT EXISTS asked    TEXT[] NOT NULL DEFAULT '{}';   -- unknown words / numbers the bot asked about
ALTER TABLE search_log ADD COLUMN IF NOT EXISTS ai_error TEXT;                            -- why the AI read failed (source = fallback)
CREATE INDEX IF NOT EXISTS search_log_disagree ON search_log (created_at DESC) WHERE cardinality(disagree) > 0;
