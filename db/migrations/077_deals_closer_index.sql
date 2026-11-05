-- 077: the commissions tab filters deals by the broker who closed them (a broker's list, a team's list). The closing
-- broker has no index yet, so this covers the agency + closer + closing date order the list uses.
CREATE INDEX IF NOT EXISTS idx_deals_agency_closer_closed ON deals (agency_id, closing_broker_id, closed_at DESC);
