-- A client request does not have to be tied to a lead: saved searches with alerts (lead_id empty) record their matches
-- in lead_matches too, so the match sweep alerts the broker once per new unit.
ALTER TABLE lead_matches ALTER COLUMN lead_id DROP NOT NULL;
