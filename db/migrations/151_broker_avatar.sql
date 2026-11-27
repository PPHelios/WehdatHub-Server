-- Broker profile photo: storage key in the listing-images bucket (avatars/<agency>/<broker>-<ts>.jpg), null when unset.
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS avatar_path text;
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS avatar_updated_at timestamptz;
