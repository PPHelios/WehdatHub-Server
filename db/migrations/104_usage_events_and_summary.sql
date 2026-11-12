-- 104: feature-adoption and timing events (app and server), and one daily summary table that keeps the totals and
-- averages after the detail rows are deleted (90 days, lib/logRollup.js).
CREATE TABLE IF NOT EXISTS usage_events (
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  agency_id   UUID REFERENCES agencies(id) ON DELETE CASCADE,
  broker_id   UUID REFERENCES brokers(id) ON DELETE SET NULL,
  channel     TEXT NOT NULL,            -- app, server
  event       TEXT NOT NULL,
  ok          BOOLEAN NOT NULL DEFAULT TRUE,
  ms          INT,
  meta        JSONB
);
CREATE INDEX IF NOT EXISTS usage_events_time ON usage_events (created_at);
CREATE INDEX IF NOT EXISTS usage_events_agency_event ON usage_events (agency_id, event, created_at DESC);
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS log_daily_summary (
  day        DATE NOT NULL,
  agency_id  UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  source     TEXT NOT NULL,             -- usage_events, operation_logs, search_log
  name       TEXT NOT NULL,
  n          INT NOT NULL DEFAULT 0,
  ok_n       INT NOT NULL DEFAULT 0,
  ms_n       INT NOT NULL DEFAULT 0,
  ms_sum     BIGINT NOT NULL DEFAULT 0,
  ms_avg     INT,
  ms_max     INT,
  PRIMARY KEY (day, agency_id, source, name)
);
ALTER TABLE log_daily_summary ENABLE ROW LEVEL SECURITY;
