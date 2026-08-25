-- Signal tracking schema for macross-backend
-- Run once against your Railway Postgres instance

CREATE TABLE IF NOT EXISTS signals (
  id SERIAL PRIMARY KEY,
  ticker TEXT NOT NULL,
  setup_type TEXT NOT NULL,        -- 'ma_crossover', 'fvg_fill', 'mss', 'orb', etc.
  conviction_score INT,            -- your existing 7-point score (nullable for setups that don't use it)
  direction TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  entry_price NUMERIC NOT NULL,
  entry_time TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ORB-specific fields (null for non-ORB setups)
  or_high NUMERIC,
  or_low NUMERIC,
  or_window_minutes INT,

  -- Resolution fields
  outcome TEXT CHECK (outcome IN ('win', 'loss', 'scratch')),
  r_multiple NUMERIC,
  stop_price NUMERIC,              -- needed by resolver to compute R
  target_price NUMERIC,            -- needed by resolver to compute R
  resolved_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signals_unresolved ON signals (outcome) WHERE outcome IS NULL;
CREATE INDEX IF NOT EXISTS idx_signals_setup_type ON signals (setup_type);
CREATE INDEX IF NOT EXISTS idx_signals_ticker_date ON signals (ticker, entry_time);
