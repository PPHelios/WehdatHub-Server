-- 086_audit_log.sql: the audit log (patch 2, audit 2026-11-06). Reuses the empty audit_logs table: adds who/where columns and
-- protects it. Rows cannot be changed, and cannot be deleted until 12 months old (the cleanup job deletes older rows).
-- Technical logs (error_events) keep their own 90-day cleanup and are not part of this table.

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip text;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent text;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS target_type text;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS target_id text;
ALTER TABLE audit_logs ALTER COLUMN created_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (agency_id, action, created_at DESC);

CREATE OR REPLACE FUNCTION audit_logs_protect() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Only the foreign-key clean-up (agency or broker removed) may touch a row: it blanks those two ids and nothing else.
    IF NEW.id = OLD.id AND NEW.action = OLD.action AND NEW.severity IS NOT DISTINCT FROM OLD.severity
       AND NEW.payload IS NOT DISTINCT FROM OLD.payload AND NEW.created_at = OLD.created_at
       AND NEW.ip IS NOT DISTINCT FROM OLD.ip AND NEW.user_agent IS NOT DISTINCT FROM OLD.user_agent
       AND NEW.target_type IS NOT DISTINCT FROM OLD.target_type AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id
       AND (NEW.agency_id IS NULL OR NEW.agency_id = OLD.agency_id) AND (NEW.broker_id IS NULL OR NEW.broker_id = OLD.broker_id) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'audit_logs rows cannot be changed';
  END IF;
  IF OLD.created_at > NOW() - INTERVAL '12 months' THEN
    RAISE EXCEPTION 'audit_logs rows are kept for 12 months';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- A removed agency keeps its audit trail (the agency id is blanked) instead of cascading the rows away.
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_agency_id_fkey;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_agency_id_fkey FOREIGN KEY (agency_id) REFERENCES agencies(id) ON DELETE SET NULL;

DROP TRIGGER IF EXISTS audit_logs_protect_trg ON audit_logs;
CREATE TRIGGER audit_logs_protect_trg BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_protect();
