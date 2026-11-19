-- 132: What the agency decided about each post of a WhatsApp chat import, remembered across brokers, devices and the
-- website/app. chat_fp = the chat's fingerprint (domain/chatFingerprint.js), post_fp = a post's. outcome: the post was saved,
-- discarded (the person threw it away) or found unchanged (an existing unit it says nothing new about). The service keeps at most
-- 5000 rows per chat (the oldest are pruned). Server-side only (RLS on, no policies: the service role reads and writes).
-- Roll back: DROP TABLE chat_import_decisions;
CREATE TABLE IF NOT EXISTS chat_import_decisions (
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  broker_id uuid REFERENCES brokers(id) ON DELETE SET NULL,
  chat_fp text NOT NULL CHECK (length(chat_fp) BETWEEN 8 AND 64),
  post_fp text NOT NULL CHECK (length(post_fp) BETWEEN 2 AND 64),
  outcome text NOT NULL CHECK (outcome IN ('saved', 'discarded', 'unchanged')),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chat_import_decisions_key UNIQUE (agency_id, chat_fp, post_fp)
);
CREATE INDEX IF NOT EXISTS chat_import_decisions_chat_idx ON chat_import_decisions (agency_id, chat_fp, updated_at DESC);
ALTER TABLE chat_import_decisions ENABLE ROW LEVEL SECURITY;
