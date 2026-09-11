// signalScanner.js
//
// Server-side port of the dashboard's MA13/48 crossover detection. This
// exists because the ORIGINAL detection only ran in the browser — every
// signal came from postSignalToBackend(), called by the dashboard's own
// JS, only while a tab was open. Two real problems with that:
//
//   1. If nobody has the dashboard open, NOTHING gets scanned or logged,
//      no matter how good the resolver/stats pipeline underneath is.
//   2. Even with a tab open, the client only ever scanned whichever ONE
//      timeframe was currently selected (runScan() uses `currentTF`) —
//      the other five timeframes were completely dormant unless you
//      manually switched to and stayed on each one.
//
// This module runs continuously server-side, across ALL SIX timeframes,
// independent of any browser. The math below (smaArr, detectCross,
// scoreConviction, buildStock, etc.) is a direct, faithful port of the
// dashboard's client-side functions — not a reimplementation — so
// server-side and client-side detection agree on what counts as a signal.
//
// The dashboard's own postSignalToBackend() call has been removed to
// avoid double-logging the same crossover from both places.

const https = require('https');

const TF_CONFIG = {
  '5m': { interval: '5m', range: '5d' },
  '15m': { interval: '15m', range: '1mo' },
  '1h': { interval: '1h', range: '3mo' },
  '4h': { interval: '60m', range: '6mo' },
  '1d': { interval: '1d', range: '3mo' },
  '1wk': { interval: '1wk', range: '2y' },
};

const TICKERS = ['AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA','AMD','AVGO','CRM','QCOM','JPM','BAC','V','MA','XOM','CVX','LLY','UNH','SPY','QQQ','IWM','INTC','MU','ORCL','PYPL','AMGN','GILD','JNJ','PG','HD','MCD','DIS','NFLX','SBUX','COST','WMT','T','VZ','PFE','ABBV','BMY','RTX','CAT','GE','XLF','XLK','XLE','XLV','XLI','XLU','DIA','PLTR','NBIS','MRVL','MSTR','COIN','GLD'];

// ── Yahoo fetch (same shape/approach as server.js's fetchFromYahoo) ─────────
function fetchFromYahoo(sym, interval, range) {
  return new Promise((resolve) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}`;
    const opts = { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/', 'Origin': 'https://finance.yahoo.com' } };
    const req = https.get(url, opts, (yfRes) => {
      let raw = '';
      yfRes.on('data', (chunk) => (raw += chunk));
      yfRes.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          const result = parsed?.chart?.result?.[0];
          if (!result) return resolve({ error: 'no result from Yahoo' });
          const q = result.indicators?.quote?.[0];
          if (!q?.close) return resolve({ error: 'no quote data' });
          let last = q.close.find((v) => v != null) || 0;
          const closes = q.close.map((v) => { if (v != null) last = v; return last; });
          const highs = (q.high || []).map((v, i) => v || closes[i]);
          const lows = (q.low || []).map((v, i) => v || closes[i]);
          const volumes = (q.volume || []).map((v) => v || 0);
          resolve({ closes, highs, lows, volumes });
        } catch (e) {
          resolve({ error: 'parse error: ' + e.message });
        }
      });
    });
    req.on('error', (e) => resolve({ error: 'fetch error: ' + e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

async function fetchBatch(tickers, interval, range, concurrency = 10) {
  const results = {};
  let i = 0;
  async function worker() {
    while (i < tickers.length) {
      const sym = tickers[i++];
      results[sym] = await fetchFromYahoo(sym, interval, range);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tickers.length) }, worker));
  return results;
}

// ── MATH (faithful port from the dashboard — do not diverge) ────────────────
function smaArr(arr, n) {
  return arr.map((_, i) => (i < n - 1 ? null : arr.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n));
}
function rollingVWAP(h, l, c, v, win = 20) {
  return c.map((_, i) => {
    const s = Math.max(0, i - win + 1);
    let tpv = 0, vol = 0;
    for (let j = s; j <= i; j++) { tpv += ((h[j] + l[j] + c[j]) / 3) * v[j]; vol += v[j]; }
    return vol > 0 ? tpv / vol : c[i];
  });
}
function calcOBV(closes, volumes) {
  const obv = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) obv.push(obv[i - 1] + volumes[i]);
    else if (closes[i] < closes[i - 1]) obv.push(obv[i - 1] - volumes[i]);
    else obv.push(obv[i - 1]);
  }
  return obv;
}
function volTrending(volumes, n) {
  if (volumes.length < n) return false;
  const recent = volumes.slice(-n);
  let up = 0;
  for (let i = 1; i < recent.length; i++) { if (recent[i] > recent[i - 1]) up++; }
  return up >= Math.floor(n / 2) + 1;
}
function detectCross(closes) {
  const m13 = smaArr(closes, 13), m48 = smaArr(closes, 48), n = closes.length - 1;
  if (!m13[n] || !m48[n] || !m13[n - 1] || !m48[n - 1]) return null;
  let sig = null;
  if (m13[n - 1] <= m48[n - 1] && m13[n] > m48[n]) sig = 'bull';
  else if (m13[n - 1] >= m48[n - 1] && m13[n] < m48[n]) sig = 'bear';
  if (!sig) return null;
  return { sig, ma13: m13[n], ma48: m48[n] };
}
function scoreConviction(s) {
  const { signal, price, vwap, ma13, ma48, chg, volume, avgVol, obvArr, volumes } = s;
  let score = 0;
  const av = price > vwap;
  const n = obvArr.length;
  const obvRising = n > 3 && obvArr[n - 1] > obvArr[n - 4];
  const volSurge = volume > avgVol * 1.5;
  const volTrend = volTrending(volumes, 5);
  const checks = signal === 'bull'
    ? [av, ma13 > vwap, chg > 0, volSurge, volTrend, obvRising, Math.abs(ma13 - ma48) / ma48 * 100 > 0.3]
    : [!av, ma13 < vwap, chg < 0, volSurge, volTrend, !obvRising, Math.abs(ma13 - ma48) / ma48 * 100 > 0.3];
  checks.forEach((v) => { if (v) score++; });
  return score;
}
function buildStock(sym, closes, highs, lows, volumes, tf) {
  if (closes.length < 52) return null;
  const price = closes[closes.length - 1], prev = closes[closes.length - 2];
  const chg = (price - prev) / prev * 100;
  const cross = detectCross(closes);
  if (!cross) return null;
  const vwapArr = rollingVWAP(highs, lows, closes, volumes, 20);
  const vwap = vwapArr[vwapArr.length - 1];
  const rv = volumes.slice(-20).filter((x) => x > 0);
  const avgVol = rv.length ? rv.reduce((a, b) => a + b, 0) / rv.length : 1;
  const volume = volumes[volumes.length - 1] || 0;
  const obvArr = calcOBV(closes, volumes);
  const stock = { ticker: sym, price, chg, signal: cross.sig, ma13: cross.ma13, ma48: cross.ma48, volume, avgVol, vwap, tf, obvArr, volumes };
  stock.score = scoreConviction(stock);
  return stock;
}

// ── Per-timeframe "previous signal" tracking ────────────────────────────────
// Mirrors the dashboard's own `prev` map, but one per timeframe (the
// dashboard only ever tracked the single currently-viewed timeframe) —
// in-memory, resets on server restart, same as the dashboard resets on
// page reload.
const prevSignals = {}; // { [tf]: { [ticker]: 'bull'|'bear' } }
for (const tf of Object.keys(TF_CONFIG)) prevSignals[tf] = {};

async function logSignal(pool, stock) {
  // Same 1% stop / 2% target (2R) convention used by the dashboard's own
  // postSignalToBackend — kept identical so stats aren't skewed by two
  // different sizing rules depending on which system logged the signal.
  const stopPct = 0.01, targetPct = 0.02;
  const direction = stock.signal === 'bull' ? 'long' : 'short';
  const stop_price = stock.signal === 'bull' ? stock.price * (1 - stopPct) : stock.price * (1 + stopPct);
  const target_price = stock.signal === 'bull' ? stock.price * (1 + targetPct) : stock.price * (1 - targetPct);

  try {
    await pool.query(
      `INSERT INTO signals
        (ticker, setup_type, conviction_score, direction, entry_price, stop_price, target_price, tf)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [stock.ticker, 'ma_crossover', stock.score, direction, stock.price, stop_price, target_price, stock.tf]
    );
  } catch (err) {
    console.error(`signalScanner: failed to log signal for ${stock.ticker} (${stock.tf}):`, err.message);
  }
}

async function scanTimeframe(pool, tf) {
  const cfg = TF_CONFIG[tf];
  const data = await fetchBatch(TICKERS, cfg.interval, cfg.range);
  let detected = 0;

  for (const sym of TICKERS) {
    const d = data[sym];
    if (!d || d.error || !d.closes) continue;
    const stock = buildStock(sym, d.closes, d.highs, d.lows, d.volumes, tf);
    if (!stock) continue;

    const prev = prevSignals[tf][sym];
    if (!prev || prev !== stock.signal) {
      await logSignal(pool, stock);
      detected++;
    }
    prevSignals[tf][sym] = stock.signal;
  }
  if (detected > 0) {
    console.log(`signalScanner: ${tf} pass logged ${detected} new/changed signal(s)`);
  }
}

let scanRunning = false;

async function runFullCycle(pool) {
  if (scanRunning) return; // don't stack overlapping cycles
  scanRunning = true;
  try {
    for (const tf of Object.keys(TF_CONFIG)) {
      await scanTimeframe(pool, tf);
    }
  } catch (err) {
    console.error('signalScanner: cycle failed:', err.message);
  } finally {
    scanRunning = false;
  }
}

// Runs a full 6-timeframe x 58-ticker cycle, then waits at least
// MIN_CYCLE_GAP_MS before starting the next one — a full cycle can take a
// few minutes given ~350 Yahoo fetches, so this avoids a fixed interval
// stacking cycles on top of each other if one runs long.
const MIN_CYCLE_GAP_MS = 60 * 1000;

function startSignalScanner(pool) {
  async function loop() {
    await runFullCycle(pool);
    setTimeout(loop, MIN_CYCLE_GAP_MS);
  }
  console.log('signalScanner: starting continuous server-side crossover detection (all 6 timeframes)');
  loop();
}

module.exports = { startSignalScanner, TF_CONFIG, TICKERS };
