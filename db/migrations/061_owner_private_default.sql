-- 061: owner profiles are visible to the team by default; only the agency owner marks one private. Existing rows keep
-- their value (the rows imported before this change stay as they are until the agency owner changes them).
ALTER TABLE unit_owners ALTER COLUMN is_private SET DEFAULT false;
