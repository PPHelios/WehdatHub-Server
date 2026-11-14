-- Inbox: a notification a person deletes is hidden from their inbox (the managers' notification log keeps it).
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;
