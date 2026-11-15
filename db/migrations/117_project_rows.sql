-- 117: a project's details as rows and columns, so the catalogue search can filter on every one of them.
-- A pasted launch message (or the form) fills: its place (the same graph as units: place_id, area_id, subzone_id and
-- place_ids = the place, every area above it and its zones), its features, size in acres, price from, lowest down payment,
-- longest term, discount, bedrooms and unit types, plus one row per unit offer (project_offers, source 'paste') and one row
-- per other fact (project_facts: consultant, operator, rental mandate…). search_text holds all of it for a plain text search.
-- Roll back: DROP TABLE project_facts; ALTER TABLE projects DROP COLUMN … (the columns below); ALTER TABLE project_offers DROP COLUMN property_type, DROP COLUMN discount_pct;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS place_id uuid REFERENCES map_places(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS area_id uuid REFERENCES areas(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS subzone_id uuid REFERENCES areas(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS governorate text;
-- A new sub-area asked for with the project (pending until the CRM owner approves it; the project is filed under its parent meanwhile).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS pending_area_id uuid REFERENCES areas(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS place_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS feature_keys text[] NOT NULL DEFAULT '{}';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS features_other text[] NOT NULL DEFAULT '{}';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS property_types text[] NOT NULL DEFAULT '{}';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS bedroom_options smallint[] NOT NULL DEFAULT '{}';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS area_acres numeric CHECK (area_acres IS NULL OR area_acres >= 0);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS price_from numeric CHECK (price_from IS NULL OR price_from >= 0);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS down_pct_min numeric CHECK (down_pct_min IS NULL OR down_pct_min BETWEEN 0 AND 100);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS years_max numeric CHECK (years_max IS NULL OR years_max BETWEEN 0 AND 20);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS discount_pct numeric CHECK (discount_pct IS NULL OR discount_pct BETWEEN 0 AND 100);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_text text CHECK (source_text IS NULL OR length(source_text) <= 8000);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS search_text text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_projects_place_ids ON projects USING gin (place_ids);
CREATE INDEX IF NOT EXISTS idx_projects_feature_keys ON projects USING gin (feature_keys);
CREATE INDEX IF NOT EXISTS idx_projects_property_types ON projects USING gin (property_types);
CREATE INDEX IF NOT EXISTS idx_projects_bedroom_options ON projects USING gin (bedroom_options);
CREATE INDEX IF NOT EXISTS idx_projects_price_from ON projects (agency_id, price_from);

ALTER TABLE project_offers ADD COLUMN IF NOT EXISTS property_type text;
ALTER TABLE project_offers ADD COLUMN IF NOT EXISTS discount_pct numeric;

CREATE TABLE IF NOT EXISTS project_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 40),
  label_ar text NOT NULL CHECK (length(label_ar) <= 80),
  label_en text NOT NULL CHECK (length(label_en) <= 80),
  value text NOT NULL CHECK (length(btrim(value)) BETWEEN 1 AND 300),
  source text NOT NULL DEFAULT 'paste' CHECK (source IN ('paste', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_facts_project ON project_facts (project_id, key);
ALTER TABLE project_facts ENABLE ROW LEVEL SECURITY;
