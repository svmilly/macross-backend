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
  tf TEXT,                         -- '5m','15m','1h','4h','1d','1wk' — drives the resolver's scratch window

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

-- Option-specific columns (nullable — only populated for asset_class = 'option').
ALTER TABLE executed_orders ADD COLUMN IF NOT EXISTS asset_class TEXT NOT NULL DEFAULT 'equity';
ALTER TABLE executed_orders ADD COLUMN IF NOT EXISTS occ_symbol TEXT;
ALTER TABLE executed_orders ADD COLUMN IF NOT EXISTS strike NUMERIC;
ALTER TABLE executed_orders ADD COLUMN IF NOT EXISTS expiration DATE;
ALTER TABLE executed_orders ADD COLUMN IF NOT EXISTS option_type TEXT;

-- Auto-close support: each entry carries its own stop/target (copied from
-- the linked signal at entry time, or supplied directly) and tracks whether
-- it's still open. 'direction' drives which way is "stop" vs "target" and
-- what the closing side should be — see execution/README.md.
ALTER TABLE executed_orders ADD COLUMN IF NOT EXISTS direction TEXT;              -- 'long' | 'short' | NULL (unmonitored)
ALTER TABLE executed_orders ADD COLUMN IF NOT EXISTS stop_price NUMERIC;
ALTER TABLE executed_orders ADD COLUMN IF NOT EXISTS target_price NUMERIC;
ALTER TABLE executed_orders ADD COLUMN IF NOT EXISTS is_closed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE executed_orders ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE executed_orders ADD COLUMN IF NOT EXISTS closed_by_order_id INT REFERENCES executed_orders(id);
ALTER TABLE executed_orders ADD COLUMN IF NOT EXISTS close_reason TEXT;           -- 'stop' | 'target' | NULL

CREATE INDEX IF NOT EXISTS idx_executed_orders_open ON executed_orders (is_closed) WHERE is_closed = false AND status = 'filled';

-- Signal→execution wiring: marks a signal as already acted on (traded or
-- deliberately skipped), so the watcher never fires twice for the same row.
ALTER TABLE signals ADD COLUMN IF NOT EXISTS auto_traded BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS tf TEXT;
