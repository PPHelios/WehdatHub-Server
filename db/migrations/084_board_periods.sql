-- 084: the CRM owner's board periods become Yesterday (1 day), 7 days and Month (30 days); 90 days is dropped.
ALTER TABLE admin_board_snapshots DROP CONSTRAINT IF EXISTS admin_board_snapshots_period_days_check;
DELETE FROM admin_board_snapshots WHERE period_days NOT IN (1, 7, 30);
ALTER TABLE admin_board_snapshots ADD CONSTRAINT admin_board_snapshots_period_days_check CHECK (period_days = ANY (ARRAY[1, 7, 30]));
