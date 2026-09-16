// execution/guardrails.js
//
// Safety checks shared by signalWatcher.js (entries) and positionMonitor.js
// (exits). Everything is env-configurable with conservative defaults, and
// none of it requires schema changes.
//
//   AUTO_TRADE_TIMEFRAMES        comma-separated allowlist, default all six
//                                (5m,15m,1h,4h,1d,1wk)
//   AUTO_TRADE_MAX_AGE_MINUTES   optional single override for ALL timeframes;
//                                otherwise per-timeframe defaults below
//   AUTO_TRADE_MAX_PER_DAY       max auto-trade entries per ET calendar day,
//                                default 10
//   AUTO_TRADE_ALLOW_STACKING    'true' to allow a new entry on a ticker that
//                                already has an open position (default off)

const { getMarketClock } = require('./tradierOrders');

const ALL_TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d', '1wk'];

const ALLOWED_TIMEFRAMES = (process.env.AUTO_TRADE_TIMEFRAMES || ALL_TIMEFRAMES.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// How long a signal stays actionable after it's logged. Roughly one to two
// bars for intraday timeframes; daily/weekly allow enough slack for an
// after-hours crossover to still be tradable at the next open.
const DEFAULT_MAX_AGE_MINUTES = {
  '5m': 10,
  '15m': 30,
  '1h': 90,
  '4h': 300,
  '1d': 36 * 60,
  '1wk': 72 * 60,
};
const FALLBACK_MAX_AGE_MINUTES = 30; // signals with no/unknown tf

const MAX_PER_DAY = Number(process.env.AUTO_TRADE_MAX_PER_DAY || 10);
const ALLOW_STACKING = process.env.AUTO_TRADE_ALLOW_STACKING === 'true';

const ENTRY_SIDES = ['buy', 'sell_short', 'buy_to_open', 'sell_to_open'];
const NON_TRADE_STATUSES = ['error', 'rejected', 'canceled', 'expired'];

function timeframeAllowed(tf) {
  return tf != null && ALLOWED_TIMEFRAMES.includes(tf);
}

function maxAgeMinutes(tf) {
  if (process.env.AUTO_TRADE_MAX_AGE_MINUTES) return Number(process.env.AUTO_TRADE_MAX_AGE_MINUTES);
  return DEFAULT_MAX_AGE_MINUTES[tf] ?? FALLBACK_MAX_AGE_MINUTES;
}

function isStale(signal, now = Date.now()) {
  const created = new Date(signal.created_at || signal.entry_time).getTime();
  if (!Number.isFinite(created)) return true; // can't tell how old it is — don't trade it
  return now - created > maxAgeMinutes(signal.tf) * 60 * 1000;
}

// ── Market hours ────────────────────────────────────────────────────────────
// Prefers Tradier's clock (knows holidays/half-days). Falls back to a plain
// weekday 9:30–16:00 ET check if the clock call fails. Cached for 60s so the
// watcher (30s) and monitor (60s) don't hammer the endpoint.

let clockCache = { at: 0, open: false };

function localMarketOpen(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

async function isMarketOpen() {
  if (Date.now() - clockCache.at < 60 * 1000) return clockCache.open;
  let open;
  try {
    const clock = await getMarketClock();
    open = clock?.state === 'open';
  } catch (err) {
    console.warn('guardrails: Tradier market clock unavailable, using local ET hours:', err.message);
    open = localMarketOpen();
  }
  clockCache = { at: Date.now(), open };
  return open;
}

// ── Database-backed checks ──────────────────────────────────────────────────

const ET_TODAY_START = `(date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')`;

async function autoTradesToday(pool) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM executed_orders
     WHERE signal_id IS NOT NULL
       AND side = ANY($1)
       AND status IS NOT NULL
       AND status NOT LIKE 'skipped%'
       AND status <> ALL($2)
       AND requested_at >= ${ET_TODAY_START}`,
    [ENTRY_SIDES, NON_TRADE_STATUSES]
  );
  return rows[0].n;
}

async function dailyCapReached(pool) {
  return (await autoTradesToday(pool)) >= MAX_PER_DAY;
}

// Any open or still-working entry on this ticker, manual or automatic.
async function hasOpenPosition(pool, ticker) {
  if (ALLOW_STACKING) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM executed_orders
     WHERE ticker = $1
       AND is_closed = false
       AND side = ANY($2)
       AND status IN ('filled', 'open', 'pending', 'partially_filled')
     LIMIT 1`,
    [ticker, ENTRY_SIDES]
  );
  return rows.length > 0;
}

// Marks every open option whose expiration date is before today (ET) as
// closed. No order is sent — the contract no longer exists to trade.
async function closeExpiredOptions(pool) {
  const { rows } = await pool.query(
    `UPDATE executed_orders
     SET is_closed = true, closed_at = now(), close_reason = 'expired'
     WHERE asset_class = 'option'
       AND is_closed = false
       AND expiration IS NOT NULL
       AND expiration < (now() AT TIME ZONE 'America/New_York')::date
     RETURNING id, ticker, occ_symbol`
  );
  for (const r of rows) {
    console.log(`guardrails: marked expired option ${r.occ_symbol} (#${r.id}, ${r.ticker}) closed`);
  }
  return rows.length;
}

module.exports = {
  ALLOWED_TIMEFRAMES,
  MAX_PER_DAY,
  timeframeAllowed,
  maxAgeMinutes,
  isStale,
  isMarketOpen,
  localMarketOpen,
  autoTradesToday,
  dailyCapReached,
  hasOpenPosition,
  closeExpiredOptions,
};
