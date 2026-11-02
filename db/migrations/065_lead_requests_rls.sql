-- 065: lead_requests is read and written only by the server, like every other public table; row-level security on.
ALTER TABLE lead_requests ENABLE ROW LEVEL SECURITY;
