// jobs/orbDetector.js
// Run once per ticker, shortly after each opening-range window closes
// (e.g. at 9:45 ET for a 15min ORB), then keep polling for a breakout
// close until end of day or breakout found.
//
// Usage:
//   const { computeOpeningRange, checkBreakout } = require('./jobs/orbDetector');
//   const range = await computeOpeningRange('SPY', 15, getCandles);
//   // later, on each new candle close:
//   const signal = checkBreakout(range, latestCandle);
//   if (signal) await logSignal(signal); // POST to /api/signals

// getCandles(ticker, { from, to, interval }) -> Promise<Candle[]>
// Candle = { time, open, high, low, close }

async function computeOpeningRange(ticker, windowMinutes, getCandles) {
  const marketOpen = getMarketOpenToday(); // implement per your existing time utils
  const windowEnd = new Date(marketOpen.getTime() + windowMinutes * 60 * 1000);

  const candles = await getCandles(ticker, {
    from: marketOpen,
    to: windowEnd,
    interval: '1min',
  });

  if (!candles.length) return null;

  const or_high = Math.max(...candles.map((c) => c.high));
  const or_low = Math.min(...candles.map((c) => c.low));

  return { ticker, or_high, or_low, or_window_minutes: windowMinutes };
}

// Call this on each new candle after the opening range is set.
// Returns a signal payload (ready to POST to /api/signals) or null.
function checkBreakout(range, candle, options = {}) {
  const { stopBufferPct = 0.1, riskRewardRatio = 2 } = options;

  if (candle.close > range.or_high) {
    const entry_price = candle.close;
    const stop_price = range.or_low; // conservative: stop at opposite side of range
    const risk = entry_price - stop_price;
    return {
      ticker: range.ticker,
      setup_type: 'orb',
      direction: 'long',
      entry_price,
      or_high: range.or_high,
      or_low: range.or_low,
      or_window_minutes: range.or_window_minutes,
      stop_price,
      target_price: entry_price + risk * riskRewardRatio,
    };
  }

  if (candle.close < range.or_low) {
    const entry_price = candle.close;
    const stop_price = range.or_high;
    const risk = stop_price - entry_price;
    return {
      ticker: range.ticker,
      setup_type: 'orb',
      direction: 'short',
      entry_price,
      or_high: range.or_high,
      or_low: range.or_low,
      or_window_minutes: range.or_window_minutes,
      stop_price,
      target_price: entry_price - risk * riskRewardRatio,
    };
  }

  return null; // still inside the range, no breakout yet
}

function getMarketOpenToday() {
  // Replace with whatever timezone-safe helper you already use in
  // macross-backend for the Level Ladder's premarket levels.
  const now = new Date();
  const open = new Date(now);
  open.setHours(9, 30, 0, 0); // 9:30 AM ET — adjust for server TZ vs ET
  return open;
}

module.exports = { computeOpeningRange, checkBreakout };
