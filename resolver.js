// jobs/resolver.js
// Run on an interval (e.g. every 2-5 min during market hours) via
// node-cron, or as a Railway cron job hitting a /internal/resolve endpoint.
//
// Usage:
//   const resolveOpenSignals = require('./jobs/resolver');
//   setInterval(() => resolveOpenSignals(pool, getPrice), 2 * 60 * 1000);
//
// getPrice(ticker) -> Promise<number> should wrap your existing
// Yahoo Finance / Tradier proxy — reuse whatever you already call
// for the Level Ladder dashboard.

async function resolveOpenSignals(pool, getPrice) {
  const { rows: openSignals } = await pool.query(
    `SELECT * FROM signals WHERE outcome IS NULL`
  );

  for (const signal of openSignals) {
    let currentPrice;
    try {
      currentPrice = await getPrice(signal.ticker);
    } catch (err) {
      console.error(`Price fetch failed for ${signal.ticker}:`, err.message);
      continue; // leave unresolved, try again next run
    }

    const outcome = evaluateOutcome(signal, currentPrice);
    if (!outcome) continue; // still open, neither stop nor target hit

    const rMultiple = computeRMultiple(signal, outcome, currentPrice);

    await pool.query(
      `UPDATE signals
       SET outcome = $1, r_multiple = $2, resolved_at = now()
       WHERE id = $3`,
      [outcome, rMultiple, signal.id]
    );

    console.log(
      `Resolved signal #${signal.id} (${signal.ticker} ${signal.setup_type}): ${outcome} (${rMultiple}R)`
    );
  }
}

// Decide win/loss based on stop/target being hit.
// If a signal has no stop_price/target_price set, OR neither has been hit
// yet, this falls back to a time-based scratch. The scratch window scales
// with the signal's timeframe (tf) — a weekly-chart crossover is a
// multi-week thesis and shouldn't be judged on a 100-minute clock the way
// a 5-minute chart signal should. Each window here is roughly "15 bars
// worth of time" for that timeframe — a heuristic, not a precise rule;
// tune SCRATCH_WINDOWS_MS if your setups typically resolve faster/slower.
const SCRATCH_WINDOWS_MS = {
  '5m': 100 * 60 * 1000,          // 100 min  (~15 bars)
  '15m': 4 * 60 * 60 * 1000,      // 4 hours  (~15 bars)
  '1h': 2 * 24 * 60 * 60 * 1000,  // 2 days   (~15 bars across sessions)
  '4h': 5 * 24 * 60 * 60 * 1000,  // 5 days   (~15 bars)
  '1d': 21 * 24 * 60 * 60 * 1000, // 21 days  (~15 trading days)
  '1wk': 105 * 24 * 60 * 60 * 1000, // 105 days (~15 weeks)
};
const DEFAULT_SCRATCH_MS = SCRATCH_WINDOWS_MS['5m']; // fallback for signals with no tf set (e.g. logged before this existed)

function scratchWindowFor(signal) {
  return SCRATCH_WINDOWS_MS[signal.tf] ?? DEFAULT_SCRATCH_MS;
}

function evaluateOutcome(signal, currentPrice) {
  const isLong = signal.direction === 'long';

  if (signal.target_price != null && signal.stop_price != null) {
    if (isLong) {
      if (currentPrice >= signal.target_price) return 'win';
      if (currentPrice <= signal.stop_price) return 'loss';
    } else {
      if (currentPrice <= signal.target_price) return 'win';
      if (currentPrice >= signal.stop_price) return 'loss';
    }
  }

  const elapsed = Date.now() - new Date(signal.entry_time).getTime();
  if (elapsed > scratchWindowFor(signal)) return 'scratch';

  return null; // still open
}

function computeRMultiple(signal, outcome, currentPrice) {
  if (outcome === 'scratch') {
    // approximate R using actual move vs. planned risk, if risk is known
    if (signal.stop_price == null) return 0;
    const risk = Math.abs(signal.entry_price - signal.stop_price);
    const moved = signal.direction === 'long'
      ? currentPrice - signal.entry_price
      : signal.entry_price - currentPrice;
    return risk ? +(moved / risk).toFixed(2) : 0;
  }
  return outcome === 'win' ? 1 : -1; // simple fixed-R model; refine if you use partials
}

module.exports = resolveOpenSignals;
