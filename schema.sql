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

-- Executed orders — audit trail linking real (or sandbox) Tradier orders
-- back to the signal that triggered them, so fills can be compared against
-- backtested win-rate/expectancy stats from the signals table.
CREATE TABLE IF NOT EXISTS executed_orders (
  id SERIAL PRIMARY KEY,
  signal_id INT REFERENCES signals(id),  -- nullable: allows manual/ad-hoc test orders too
  tradier_order_id TEXT,
  ticker TEXT NOT NULL,
  side TEXT NOT NULL,                    -- buy, sell, buy_to_cover, sell_short
  quantity NUMERIC NOT NULL,
  order_type TEXT NOT NULL DEFAULT 'market',
  status TEXT,                           -- raw status Tradier returned (ok, rejected, etc.)
  tradier_env TEXT NOT NULL,             -- 'sandbox' or 'live' — which environment placed it
  conviction_score INT,
  error TEXT,                            -- populated if the order attempt failed
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_response JSONB                     -- full Tradier response for debugging
);

CREATE INDEX IF NOT EXISTS idx_executed_orders_signal ON executed_orders (signal_id);
CREATE INDEX IF NOT EXISTS idx_executed_orders_ticker ON executed_orders (ticker, requested_at);
