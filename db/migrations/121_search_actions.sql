-- 121: what a broker does after a project search (Ask results): changed a filter or sort, removed a chip, turned the page, opened a project, sent one to a
-- client. One row per action, tied to the search (search_log, channel 'ask'), so the owner can see which readings were useful and which were left at once.
-- Roll back: DROP TABLE search_actions;
CREATE TABLE IF NOT EXISTS search_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  broker_id uuid REFERENCES brokers(id) ON DELETE SET NULL,
  search_log_id uuid NOT NULL REFERENCES search_log(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('filter', 'sort', 'chip_drop', 'page', 'open', 'send', 'report')),
  detail text CHECK (detail IS NULL OR length(detail) <= 120),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_search_actions_log ON search_actions (search_log_id);
CREATE INDEX IF NOT EXISTS idx_search_actions_time ON search_actions (created_at DESC);
ALTER TABLE search_actions ENABLE ROW LEVEL SECURITY;
