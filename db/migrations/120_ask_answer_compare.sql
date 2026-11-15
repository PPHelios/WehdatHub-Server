-- 120: Ask keeps both answer lines so they can be compared later: the AI's (answer first) and the one written from the results by code
-- (domain/projectAnswerLine.js). answer_source says which one the broker saw ('ai' or 'local'); search_log_id points to the reading of the
-- question (search_log, channel 'ask'), where the parser's and the AI's filters are kept side by side.
-- Roll back: ALTER TABLE assistant_questions DROP COLUMN local_answer, DROP COLUMN ai_answer, DROP COLUMN answer_source, DROP COLUMN search_log_id;
ALTER TABLE assistant_questions ADD COLUMN IF NOT EXISTS local_answer text;
ALTER TABLE assistant_questions ADD COLUMN IF NOT EXISTS ai_answer text;
ALTER TABLE assistant_questions ADD COLUMN IF NOT EXISTS answer_source text CHECK (answer_source IS NULL OR answer_source IN ('ai', 'local'));
ALTER TABLE assistant_questions ADD COLUMN IF NOT EXISTS search_log_id uuid REFERENCES search_log(id) ON DELETE SET NULL;
