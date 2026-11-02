-- 059: the agency owner's private owner profiles. Matches the column already on the live database (applied as
-- 059_owner_private); written idempotently so a database that has it is unchanged. Default fixed by 061.
ALTER TABLE unit_owners ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT true;
