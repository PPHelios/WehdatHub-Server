-- 063: every search is kept for the POC so errors can be spotted and reported: the words as typed or spoken (phone
-- numbers hidden), what the local parser read, what the AI read (when it was asked), the filters actually used and the
-- units returned. A broker can report a search as wrong; the report keeps both readings for review.
CREATE TABLE IF NOT EXISTS search_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id     UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  broker_id     UUID REFERENCES brokers(id) ON DELETE SET NULL,
  channel       TEXT NOT NULL,                       -- web, telegram, whatsapp, voice
  query_text    TEXT NOT NULL,
  source        TEXT NOT NULL,                       -- parser, ai, fallback (AI asked but could not answer), form, link
  reasons       TEXT[] NOT NULL DEFAULT '{}',        -- why the local parser was unsure
  local_filters JSONB,
  ai_filters    JSONB,
  used_filters  JSONB,
  unapplied     TEXT[] NOT NULL DEFAULT '{}',        -- phrases the filters cannot say (negations, last floor, ...)
  leftover      TEXT[] NOT NULL DEFAULT '{}',        -- words the local parser could not use
  total         INT NOT NULL DEFAULT 0,
  relaxed       BOOLEAN NOT NULL DEFAULT FALSE,
  result_ids    UUID[] NOT NULL DEFAULT '{}',        -- the first 50 units returned
  rerun_of      UUID REFERENCES search_log(id) ON DELETE SET NULL,
  audit         JSONB,                               -- the nightly check: { checked_at, bad_ids, missed_ids }
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS search_log_agency_time ON search_log (agency_id, created_at DESC);
CREATE INDEX IF NOT EXISTS search_log_time ON search_log (created_at DESC);

CREATE TABLE IF NOT EXISTS search_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_log_id UUID NOT NULL REFERENCES search_log(id) ON DELETE CASCADE,
  agency_id     UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  broker_id     UUID REFERENCES brokers(id) ON DELETE SET NULL,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fixed', 'dismissed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (search_log_id, broker_id)
);
CREATE INDEX IF NOT EXISTS search_reports_open ON search_reports (created_at) WHERE status = 'open';

ALTER TABLE search_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_reports ENABLE ROW LEVEL SECURITY;
-- 062 created lead_requests without row-level security; every table in public has it.
ALTER TABLE lead_requests ENABLE ROW LEVEL SECURITY;
