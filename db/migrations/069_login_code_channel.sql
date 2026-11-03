-- 069: (1) a website sign-in can also be a six-digit code sent on the bot, not only a link.
-- Codes live in the same table as links, hashed and bound to the broker, for 5 minutes.
ALTER TABLE web_login_tokens DROP CONSTRAINT IF EXISTS web_login_tokens_channel_check;
ALTER TABLE web_login_tokens ADD CONSTRAINT web_login_tokens_channel_check CHECK (channel IN ('whatsapp', 'web', 'code'));

-- Data entry role: adds units by hand and edits any unit that is not VIP; no leads, deals or imports.
ALTER TABLE brokers DROP CONSTRAINT IF EXISTS brokers_role_check;
ALTER TABLE brokers ADD CONSTRAINT brokers_role_check CHECK (role IN ('broker', 'agent', 'admin', 'owner', 'manager', 'team_lead', 'data_entry'));
