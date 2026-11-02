-- 062: "Ask a manager" requests become their own rows. A broker may have one open request per lead; it goes to the
-- managers or to the agency owner (to_role). Handling it sets handled_at and an optional reply; the timeline keeps the
-- events. The lead's flag columns from 055 are copied here and then no longer written.
CREATE TABLE IF NOT EXISTS lead_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id   UUID NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  lead_id     UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  broker_id   UUID REFERENCES brokers(id) ON DELETE SET NULL,
  to_role     TEXT NOT NULL DEFAULT 'manager' CHECK (to_role IN ('manager', 'owner')),
  note        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_at  TIMESTAMPTZ,
  handled_by  UUID REFERENCES brokers(id) ON DELETE SET NULL,
  reply       TEXT
);

-- One open request per broker per lead.
CREATE UNIQUE INDEX IF NOT EXISTS lead_requests_one_open ON lead_requests (lead_id, broker_id) WHERE handled_at IS NULL;
CREATE INDEX IF NOT EXISTS lead_requests_open ON lead_requests (agency_id, to_role, created_at) WHERE handled_at IS NULL;

-- Carry over the open flags from 055. They were addressed to managers.
INSERT INTO lead_requests (agency_id, lead_id, broker_id, to_role, note, created_at)
SELECT l.agency_id, l.id, l.flagged_by, 'manager', COALESCE(l.flag_note, ''), l.flagged_at
  FROM leads l
 WHERE l.flagged_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM lead_requests r WHERE r.lead_id = l.id AND r.handled_at IS NULL);
