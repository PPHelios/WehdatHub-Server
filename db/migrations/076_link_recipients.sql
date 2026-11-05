-- 076: who a link was sent to, and each counted open. A link carries its recipient (the lead, or the number typed; "no
-- recipient" is allowed), how it was made (source: bot, web, lead), and an optional note. Each counted open keeps only the
-- time, the device class and a visitor hash: the hash is salted with the link's own token and the visitor's address and
-- browser, so the same phone is recognised across its opens of one link and never across links. No raw address is stored.
-- Opens go when their link goes (180 days, cascade). Links made before this migration keep no recipient and no open rows.
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS recipient_phone text;
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE share_links DROP CONSTRAINT IF EXISTS share_links_source_check;
ALTER TABLE share_links ADD CONSTRAINT share_links_source_check CHECK (source IS NULL OR source IN ('bot', 'web', 'lead'));
ALTER TABLE share_links DROP CONSTRAINT IF EXISTS share_links_note_length;
ALTER TABLE share_links ADD CONSTRAINT share_links_note_length CHECK (note IS NULL OR char_length(note) <= 200);
CREATE INDEX IF NOT EXISTS share_links_recipient_idx ON share_links (agency_id, recipient_phone) WHERE recipient_phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS share_link_opens (
  id bigserial PRIMARY KEY,
  token_hash text NOT NULL REFERENCES share_links(token_hash) ON DELETE CASCADE,
  opened_at timestamptz NOT NULL DEFAULT now(),
  device text NOT NULL DEFAULT 'other' CHECK (device IN ('iphone', 'android', 'mac', 'windows', 'linux', 'other')),
  visitor text NOT NULL
);
CREATE INDEX IF NOT EXISTS share_link_opens_token_idx ON share_link_opens (token_hash, opened_at DESC);
ALTER TABLE share_link_opens ENABLE ROW LEVEL SECURITY;
