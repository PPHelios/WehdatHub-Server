-- 067: who led which broker, and when. A row per team a broker was under: from_at when the link was set, to_at when it
-- was changed or cleared (open while to_at is null). A team lead keeps seeing the history of a broker's actions for
-- the time that broker was in their team, even after the broker moves to another team; the broker's current lead
-- and the new team lead see what happens from the move on. Existing team links start today.
CREATE TABLE IF NOT EXISTS broker_team_history (
  id           BIGSERIAL PRIMARY KEY,
  agency_id    UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  broker_id    UUID NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
  team_lead_id UUID NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
  from_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  to_at        TIMESTAMPTZ
);
ALTER TABLE broker_team_history ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS broker_team_history_broker ON broker_team_history (broker_id, from_at);
CREATE INDEX IF NOT EXISTS broker_team_history_team ON broker_team_history (team_lead_id, from_at);
INSERT INTO broker_team_history (agency_id, broker_id, team_lead_id, from_at)
  SELECT agency_id, id, team_lead_id, now() FROM brokers b
   WHERE team_lead_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM broker_team_history h WHERE h.broker_id = b.id AND h.to_at IS NULL);
