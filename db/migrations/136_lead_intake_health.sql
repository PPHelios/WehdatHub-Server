-- 136: a Facebook intake knows when its Page token stopped working. 'disconnected' intakes are not used (no Graph call)
-- until the owner updates the token; the owner and the agency's managers are alerted once, on the change of status.
-- last_error_* records the latest Graph failure (code only, never a message with secrets) for the owner's tracking tab.
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE lead_intakes DROP CONSTRAINT IF EXISTS lead_intakes_status_check;
ALTER TABLE lead_intakes ADD CONSTRAINT lead_intakes_status_check CHECK (status IN ('active', 'disconnected'));
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS disconnect_reason text;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS disconnected_at timestamptz;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS last_error_at timestamptz;
ALTER TABLE lead_intakes ADD COLUMN IF NOT EXISTS last_error_code text;
