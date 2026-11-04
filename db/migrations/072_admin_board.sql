-- 072: the owner's dashboard reads stored results. A nightly job (and a refresh button per tab) fills one row per tab
-- and period, so opening the board never runs the heavy queries. Fixed monthly costs (Render, Supabase, ads) are entered
-- by the owner and feed the cash-flow view.
CREATE TABLE IF NOT EXISTS admin_board_snapshots (
  tab text NOT NULL CHECK (tab IN ('overview', 'money', 'ai', 'performance', 'search', 'agencies', 'operations')),
  period_days integer NOT NULL CHECK (period_days IN (7, 30, 90)),
  payload jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tab, period_days)
);

CREATE TABLE IF NOT EXISTS fixed_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month date NOT NULL,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  amount_egp numeric NOT NULL CHECK (amount_egp >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fixed_costs_month ON fixed_costs (month);

-- Like every public table: no client role may read these rows (the app reads them as the server's own role).
ALTER TABLE admin_board_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_costs ENABLE ROW LEVEL SECURITY;
