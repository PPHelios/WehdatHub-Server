ALTER TABLE agencies ADD COLUMN IF NOT EXISTS data_entry_missing_photos BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS data_entry_overdue_units BOOLEAN NOT NULL DEFAULT true;
