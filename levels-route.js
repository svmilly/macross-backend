// levels-route.js
//
// Drop this into your existing garytrades Railway backend and mount it, e.g.:
//   const levelsRouter = require('./levels-route');
//   app.use(levelsRouter);
//
// Requires:
//   - Node 18+ (built-in fetch). If your Railway service is on an older
//     Node version, install node-fetch and swap the fetch() calls below.
//   - CORS enabled on the app (you likely already have this since the
//     screener is a public proxy). If not: npm i cors, then
//     app.use(require('cors')());
//
// Env vars:
//   TRADIER_TOKEN   - your Tradier API access token (required)
//   TRADIER_ENV     - "sandbox" or "production" (default: production)
//
// Endpoint:
//   GET /api/levels?symbols=AAPL,TSLA,SPY
//   -> { asOf: ISOString, levels: [
//        { symbol, prevHigh, prevLow, prevClose, prevDate, pmHigh, pmLow, lastPrice }
//      ] }

const express = require('express');
const router = express.Router();

const TRADIER_BASE = process.env.TRADIER_ENV === 'sandbox'
  ? 'https://sandbox.tradier.com/v1'
  : 'https://api.tradier.com/v1';

function tradierHeaders() {
  return {
    Authorization: `Bearer ${process.env.TRADIER_TOKEN}`,
    Accept: 'application/json',
  };
}

// Dates in America/New_York so "today" lines up with the trading session
// regardless of what timezone the Railway container runs in.
function isoDateNY(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
}
function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return isoDateNY(d);
}

// Previous session's high / low / close from daily history.
async function getPrevDayLevels(symbol) {
  const start = daysAgoISO(10); // pad for weekends/holidays
  const end = isoDateNY();
  const url = `${TRADIER_BASE}/markets/history?symbol=${encodeURIComponent(symbol)}&interval=daily&start=${start}&end=${end}`;
  const res = await fetch(url, { headers: tradierHeaders() });
  if (!res.ok) throw new Error(`history ${symbol}: HTTP ${res.status}`);
  const data = await res.json();
  const raw = data?.history?.day;
  if (!raw) return null;

  const days = Array.isArray(raw) ? raw : [raw];
  const today = isoDateNY();
  const priorDays = days.filter(d => d.date < today);
  const prev = priorDays[priorDays.length - 1];
  if (!prev) return null;

  return {
    prevHigh: prev.high,
    prevLow: prev.low,
    prevClose: prev.close,
    prevDate: prev.date,
  };
}

// Premarket range (04:00–09:29 ET) from 1-minute time & sales.
async function getPremarketLevels(symbol) {
  const date = isoDateNY();
  const url = `${TRADIER_BASE}/markets/timesales?symbol=${encodeURIComponent(symbol)}` +
    `&interval=1min&start=${date}%2004:00&end=${date}%2009:29&session_filter=all`;
  const res = await fetch(url, { headers: tradierHeaders() });
  if (!res.ok) throw new Error(`timesales ${symbol}: HTTP ${res.status}`);
  const data = await res.json();
  const raw = data?.series?.data;
  if (!raw) return { pmHigh: null, pmLow: null };

  const bars = Array.isArray(raw) ? raw : [raw];
  const highs = bars.map(b => b.high).filter(v => typeof v === 'number');
  const lows = bars.map(b => b.low).filter(v => typeof v === 'number');
  if (!highs.length || !lows.length) return { pmHigh: null, pmLow: null };

  return { pmHigh: Math.max(...highs), pmLow: Math.min(...lows) };
}

async function getLastPrice(symbol) {
  const url = `${TRADIER_BASE}/markets/quotes?symbols=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { headers: tradierHeaders() });
  if (!res.ok) throw new Error(`quotes ${symbol}: HTTP ${res.status}`);
  const data = await res.json();
  const q = data?.quotes?.quote;
  if (!q) return null;
  const quote = Array.isArray(q) ? q[0] : q;
  return quote?.last ?? quote?.close ?? null;
}

router.get('/api/levels', async (req, res) => {
  try {
    const symbols = (req.query.symbols || '')
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);

    if (!symbols.length) {
      return res.status(400).json({ error: 'symbols query param is required, e.g. ?symbols=AAPL,TSLA' });
    }
    if (!process.env.TRADIER_TOKEN) {
      return res.status(500).json({ error: 'TRADIER_TOKEN is not set on the server.' });
    }

    const levels = await Promise.all(symbols.map(async symbol => {
      try {
        const [prev, pm, last] = await Promise.all([
          getPrevDayLevels(symbol),
          getPremarketLevels(symbol),
          getLastPrice(symbol),
        ]);
        return {
          symbol,
          prevHigh: prev?.prevHigh ?? null,
          prevLow: prev?.prevLow ?? null,
          prevClose: prev?.prevClose ?? null,
          prevDate: prev?.prevDate ?? null,
          pmHigh: pm.pmHigh,
          pmLow: pm.pmLow,
          lastPrice: last,
        };
      } catch (symErr) {
        console.error(`levels error for ${symbol}:`, symErr.message);
        return { symbol, error: symErr.message };
      }
    }));

    res.json({ asOf: new Date().toISOString(), levels });
  } catch (err) {
    console.error('levels route error:', err);
    res.status(500).json({ error: 'Failed to fetch levels.' });
  }
});

module.exports = router;
