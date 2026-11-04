-- 070: photos, flyers, logos and project files are stored as storage keys (e.g. listings/<agency>/…jpg),
-- not as full Supabase links. The app builds the link when it shows a file (lib/supabase.js photoUrl), so a move
-- off Supabase only needs the files copied and one setting changed. Existing full links are cut down to their key.

UPDATE listing_images
   SET url = regexp_replace(url, '^.*/storage/v1/object/public/listing-images/', '')
 WHERE url LIKE '%/storage/v1/object/public/listing-images/%';

UPDATE project_images
   SET url = regexp_replace(url, '^.*/storage/v1/object/public/listing-images/', '')
 WHERE url LIKE '%/storage/v1/object/public/listing-images/%';

UPDATE agencies
   SET logo_url = regexp_replace(logo_url, '^.*/storage/v1/object/public/listing-images/', '')
 WHERE logo_url LIKE '%/storage/v1/object/public/listing-images/%';

-- A stored project file keeps its key in url too (storage_path holds the same key); links to outside sites stay http(s).
UPDATE project_materials SET url = storage_path WHERE storage_path IS NOT NULL;

ALTER TABLE project_materials DROP CONSTRAINT IF EXISTS project_materials_url_check;
ALTER TABLE project_materials ADD CONSTRAINT project_materials_url_check
  CHECK (((url ~ '^https?://'::text) OR (storage_path IS NOT NULL)) AND (length(url) <= 1000));
