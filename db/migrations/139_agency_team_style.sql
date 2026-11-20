-- 139: workspace segments. team_style: how a team-tier workspace runs ('shared' = every member acts as a broker and sees all
-- units and leads; 'structured' = owner plus brokers with the owner's switches). The owner can flip it any time; the agency
-- tier ignores it. segment_hint: what sign-up said ('solo' | 'team' | 'agency'), nullable, used for trial seats.
-- agencies already has RLS on with no policy (deny-all); no new table here.
-- Roll back: ALTER TABLE agencies DROP COLUMN team_style, DROP COLUMN segment_hint;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS team_style text NOT NULL DEFAULT 'shared';
ALTER TABLE agencies DROP CONSTRAINT IF EXISTS agencies_team_style_check;
ALTER TABLE agencies ADD CONSTRAINT agencies_team_style_check CHECK (team_style IN ('shared', 'structured'));
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS segment_hint text;
ALTER TABLE agencies DROP CONSTRAINT IF EXISTS agencies_segment_hint_check;
ALTER TABLE agencies ADD CONSTRAINT agencies_segment_hint_check CHECK (segment_hint IS NULL OR segment_hint IN ('solo', 'team', 'agency'));
