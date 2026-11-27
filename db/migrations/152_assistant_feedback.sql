-- 152: Misses of the Ask assistant: a thumbs-down from the broker or an automatic "I didn't get that" (clarify). The question is
-- scrubbed first (domain/assistantFeedback.js: phones and emails removed, 200 chars). Rows older than 90 days are deleted daily.
-- Server-side only (RLS on, no policies, no anon/authenticated grants).
-- Roll back: DROP TABLE assistant_feedback;
CREATE TABLE IF NOT EXISTS assistant_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  broker_id uuid REFERENCES brokers(id) ON DELETE SET NULL,
  role text,
  lang text,
  intent text,
  route text,
  verdict text NOT NULL CHECK (verdict IN ('down', 'clarify')),
  reason text CHECK (reason IS NULL OR reason IN ('wrong', 'not_asked', 'other')),
  question text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS assistant_feedback_agency_idx ON assistant_feedback (agency_id, created_at DESC);
ALTER TABLE assistant_feedback ENABLE ROW LEVEL SECURITY;
