-- 082: the CRM owner marks a nightly search finding as handled (search review work queue).
ALTER TABLE search_log ADD COLUMN IF NOT EXISTS audit_resolved_at timestamptz;
