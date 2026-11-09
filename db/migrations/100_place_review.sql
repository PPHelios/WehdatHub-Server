-- 100: the owner's review of new places. A new compound name (place_names) can be approved as a place, merged into an
-- existing place as an alias, or rejected with a reason; a new area or sub-zone (areas.status) the same. place_proposals
-- remembers which broker proposed what, to limit how many a broker can queue per hour and to tell them when one is rejected.
-- Roll back: DROP TABLE place_proposals; ALTER TABLE place_names DROP COLUMN place_id, DROP COLUMN reject_reason; ALTER TABLE areas DROP COLUMN reject_reason.
ALTER TABLE place_names DROP CONSTRAINT IF EXISTS place_names_status_check;
ALTER TABLE place_names ADD CONSTRAINT place_names_status_check CHECK (status IN ('pending', 'approved', 'merged', 'rejected'));
ALTER TABLE place_names ADD COLUMN IF NOT EXISTS place_id uuid REFERENCES map_places(id) ON DELETE SET NULL;
ALTER TABLE place_names ADD COLUMN IF NOT EXISTS reject_reason text;
ALTER TABLE areas DROP CONSTRAINT IF EXISTS areas_status_check;
ALTER TABLE areas ADD CONSTRAINT areas_status_check CHECK (status IN ('pending', 'approved', 'rejected'));
ALTER TABLE areas ADD COLUMN IF NOT EXISTS reject_reason text;

CREATE TABLE IF NOT EXISTS place_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('compound', 'area')),
  ref_id uuid NOT NULL,
  broker_id uuid REFERENCES brokers(id) ON DELETE SET NULL,
  batch text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS place_proposals_broker ON place_proposals (broker_id, created_at DESC);
CREATE INDEX IF NOT EXISTS place_proposals_ref ON place_proposals (kind, ref_id);
ALTER TABLE place_proposals ENABLE ROW LEVEL SECURITY;
