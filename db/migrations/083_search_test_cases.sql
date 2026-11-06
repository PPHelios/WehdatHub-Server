-- 083: searches the CRM owner keeps as test cases (from a nightly finding) so the same words are checked again later.
CREATE TABLE IF NOT EXISTS search_test_cases (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  query_text text NOT NULL,
  source_log_id uuid REFERENCES search_log(id) ON DELETE SET NULL,
  created_by uuid REFERENCES brokers(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS search_test_cases_text ON search_test_cases (lower(trim(query_text)));
