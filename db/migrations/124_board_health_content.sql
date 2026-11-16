-- The owner board gains two stored tabs: health (adoption, errors, the WhatsApp import report) and content (what waits for review).
-- Additive: only the allowed tab names change. Safe to run again.
ALTER TABLE admin_board_snapshots DROP CONSTRAINT IF EXISTS admin_board_snapshots_tab_check;
ALTER TABLE admin_board_snapshots ADD CONSTRAINT admin_board_snapshots_tab_check
  CHECK (tab IN ('overview', 'money', 'ai', 'performance', 'search', 'agencies', 'operations', 'health', 'content'));
