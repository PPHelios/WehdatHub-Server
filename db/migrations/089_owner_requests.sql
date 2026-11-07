-- 089_owner_requests.sql: owner rules (patch 7, approved by the owner 2026-11-06).
-- 1) Owner codes like O-0042, numbered per agency. 2) Change requests: a broker cannot rename an owner; the request goes to the
--    approver (data entry, else a manager, else the agency owner; for a VIP owner only the agency owner).
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS owner_code_next integer NOT NULL DEFAULT 1;
ALTER TABLE unit_owners ADD COLUMN IF NOT EXISTS code text;
UPDATE unit_owners o SET code = 'O-' || lpad(n.rn::text, 4, '0')
  FROM (SELECT id, row_number() OVER (PARTITION BY agency_id ORDER BY created_at, id) AS rn FROM unit_owners) n
 WHERE n.id = o.id AND o.code IS NULL;
UPDATE agencies a SET owner_code_next = c.n + 1 FROM (SELECT agency_id, count(*)::int AS n FROM unit_owners GROUP BY agency_id) c WHERE c.agency_id = a.id;
CREATE UNIQUE INDEX IF NOT EXISTS unit_owners_code ON unit_owners (agency_id, code);

CREATE TABLE IF NOT EXISTS owner_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES unit_owners(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'rename' CHECK (kind IN ('rename')),
  old_value text,
  new_value text NOT NULL,
  requested_by uuid REFERENCES brokers(id) ON DELETE SET NULL,
  listing_id uuid REFERENCES listings(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by uuid REFERENCES brokers(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS owner_change_requests_open ON owner_change_requests (agency_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS owner_change_requests_one_pending ON owner_change_requests (owner_id, lower(new_value)) WHERE status = 'pending';
ALTER TABLE owner_change_requests ENABLE ROW LEVEL SECURITY;

-- History kinds used by rename requests and the VIP link warning.
ALTER TABLE unit_owner_events DROP CONSTRAINT IF EXISTS unit_owner_events_kind_check;
ALTER TABLE unit_owner_events ADD CONSTRAINT unit_owner_events_kind_check CHECK (kind IN ('created', 'edited', 'note', 'flag', 'unit_linked', 'unit_moved_in', 'unit_moved_out', 'rename_requested', 'rename_approved', 'rename_rejected'));
