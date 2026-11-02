-- 066: the search vocabulary that grows. An alias maps a word brokers say to a word the search dictionaries already know
-- ("فيلله" → "فيلا"). Starts with a few spellings; the AI's readings propose more (pending), the CRM owner approves them
-- (and after the first month a proposal the AI agreed on five or more times is approved automatically).
CREATE TABLE IF NOT EXISTS search_aliases (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  term         TEXT NOT NULL,                       -- normalized word as said
  target       TEXT NOT NULL,                       -- normalized word the dictionaries know
  kind         TEXT NOT NULL CHECK (kind IN ('place', 'type', 'feature')),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  source       TEXT NOT NULL DEFAULT 'ai' CHECK (source IN ('seed', 'ai', 'manual')),
  agreed       INT NOT NULL DEFAULT 1,              -- searches where the AI read the word this way
  example      TEXT,                                -- one search that used it
  decided_by   TEXT,                                -- 'owner' or 'auto'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (term, target)
);
CREATE INDEX IF NOT EXISTS search_aliases_status ON search_aliases (status, agreed DESC);
ALTER TABLE search_aliases ENABLE ROW LEVEL SECURITY;

INSERT INTO search_aliases (term, target, kind, status, source, decided_by) VALUES
  ('فيلله', 'فيلا', 'type', 'approved', 'seed', 'owner'),
  ('ڤيلا', 'فيلا', 'type', 'approved', 'seed', 'owner'),
  ('فيلات', 'فيلا', 'type', 'approved', 'seed', 'owner'),
  ('دبلكس', 'دوبلكس', 'type', 'approved', 'seed', 'owner'),
  ('ديبلكس', 'دوبلكس', 'type', 'approved', 'seed', 'owner'),
  ('دوبليكس', 'دوبلكس', 'type', 'approved', 'seed', 'owner'),
  ('بنتهوس', 'بنتهاوس', 'type', 'approved', 'seed', 'owner'),
  ('تاونهاوس', 'تاون هاوس', 'type', 'approved', 'seed', 'owner'),
  ('توينهاوس', 'توين هاوس', 'type', 'approved', 'seed', 'owner')
ON CONFLICT (term, target) DO NOTHING;
