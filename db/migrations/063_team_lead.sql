-- 063: Team Lead. A team lead is a broker (role 'team_lead') who sees the leads of the brokers under them and may
-- reassign those leads within the team, or send a lead back to the managers. A broker belongs to at most one team
-- (team_lead_id). Managers and the agency owner set both.
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS team_lead_id UUID REFERENCES brokers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS brokers_team_lead ON brokers (agency_id, team_lead_id) WHERE team_lead_id IS NOT NULL;

-- The role list gets 'team_lead' (the base schema's check allowed broker, agent, admin, owner, manager).
ALTER TABLE brokers DROP CONSTRAINT IF EXISTS brokers_role_check;
ALTER TABLE brokers ADD CONSTRAINT brokers_role_check CHECK (role IN ('broker', 'agent', 'admin', 'owner', 'manager', 'team_lead'));
