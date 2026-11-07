-- 093: a place can be approved by name before it has a position (its pin is dropped later in the owner window).
ALTER TABLE map_places ALTER COLUMN lat DROP NOT NULL;
ALTER TABLE map_places ALTER COLUMN lng DROP NOT NULL;
