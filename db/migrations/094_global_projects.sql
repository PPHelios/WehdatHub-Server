-- 094: the global project library. The CRM owner keeps a list of projects (facts only: no prices, files or commission);
-- an agency manager copies one into the agency's own projects and edits it freely. Nothing is shared live: a copy only
-- remembers where it came from (projects.global_id).
CREATE TABLE IF NOT EXISTS global_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  developer text CHECK (developer IS NULL OR length(developer) <= 120),
  region text CHECK (region IS NULL OR length(region) <= 120),
  status text CHECK (status IS NULL OR length(status) <= 60),
  unit_types text CHECK (unit_types IS NULL OR length(unit_types) <= 300),
  area_acres numeric CHECK (area_acres IS NULL OR area_acres >= 0),
  facts text CHECK (facts IS NULL OR length(facts) <= 2000),
  published boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_global_projects_name ON global_projects (lower(btrim(name)));
ALTER TABLE global_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS global_id uuid REFERENCES global_projects(id) ON DELETE SET NULL;
