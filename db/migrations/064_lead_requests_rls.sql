-- 064: row-level security on lead_requests, like every other agency table (the app reads and writes it as the service
-- role; the policy-less RLS keeps anon and authenticated clients out).
ALTER TABLE lead_requests ENABLE ROW LEVEL SECURITY;
