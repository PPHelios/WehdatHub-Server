-- 096: a place whose saved pin the owner has double-checked against OpenStreetMap and Google is marked, so the one-time
-- check never asks about it again.
ALTER TABLE map_places ADD COLUMN IF NOT EXISTS pin_checked_at timestamptz;
