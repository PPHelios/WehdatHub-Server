-- 102: a save key per unit save (add or edit). The browser makes one key when the form opens and sends it with every try of that
-- save; the key row is written in the same transaction as the unit, so a repeated try (a lost answer, a double tap, the
-- "is it saved?" check) finds the first result instead of saving twice. Rows older than 7 days are purged by the daily privacy job.
-- Roll back: DROP TABLE save_keys;
CREATE TABLE IF NOT EXISTS save_keys (
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (length(key) BETWEEN 8 AND 64),
  kind text NOT NULL CHECK (kind IN ('create', 'edit')),
  listing_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agency_id, key)
);
CREATE INDEX IF NOT EXISTS idx_save_keys_created ON save_keys (created_at);
ALTER TABLE save_keys ENABLE ROW LEVEL SECURITY;
