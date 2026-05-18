const express = require('express');
const https   = require('https');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;
const HOST    = '0.0.0.0';
const TRADIER_TOKEN = process.env.TRADIER_TOKEN || '';

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Serve screener ────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'screener.html')));
app.get('/screener', (req, res) => res.sendFile(path.join(__dirname, 'screener.html')));
app.get('/health', (req, res) => res.json({
  status: 'ok',
  message: 'MA Cross + VWAP + Options Flow server running',
  tradier: TRADIER_TOKEN ? 'connected' : 'missing',
  tickers: 58
}));

// ── Single quote ──────────────────────────────────────────────────────────────
app.get('/quote', (req, res) => {
  const { symbol, interval = '1d', range = '3mo' } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  fetchFromYahoo(symbol.toUpperCase().trim(), interval, range, (err, data) => {
    if (err) return res.status(502).json({ error: err });
    res.json(data);
  });
});

// ── Batch Yahoo Finance ───────────────────────────────────────────────────────
app.get('/batch', async (req, res) => {
  const { symbols, interval = '1d', range = '3mo' } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols required' });
  const syms = symbols.toUpperCase().split(',').map(s => s.trim()).filter(Boolean).slice(0, 100);
  const results = {};
  for (let i = 0; i < syms.length; i += 10) {
    const group = syms.slice(i, i + 10);
    await Promise.all(group.map(sym => new Promise(resolve => {
      fetchFromYahoo(sym, interval, range, (err, data) => {
        results[sym] = err ? { error: err } : data;
        resolve();
      });
    })));
    if (i + 10 < syms.length) await sleep(300);
  }
  res.json({ results, count: Object.keys(results).length, timestamp: Date.now() });
});

// ── Options Flow endpoint ─────────────────────────────────────────────────────
// Returns put/call ratio, unusual volume, and top sweeps for a symbol
app.get('/options', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  if (!TRADIER_TOKEN) return res.status(503).json({ error: 'Tradier token not configured' });

  try {
    const sym = symbol.toUpperCase().trim();
    // Step 1: Get expiration dates
    const expirations = await tradierGet(`/v1/markets/options/expirations?symbol=${sym}&includeAllRoots=true`);
    if (!expirations?.expirations?.date) return res.json(nullFlow(sym));

    const dates = Array.isArray(expirations.expirations.date)
      ? expirations.expirations.date.slice(0, 4)  // next 4 expirations
      : [expirations.expirations.date];

    // Step 2: Fetch chains for each expiration concurrently
    const chains = await Promise.all(dates.map(exp =>
      tradierGet(`/v1/markets/options/chains?symbol=${sym}&expiration=${exp}&greeks=false`)
        .catch(() => null)
    ));

    // Step 3: Aggregate all options data
    let totalCallVol = 0, totalPutVol = 0;
    let totalCallOI = 0, totalPutOI = 0;
    let avgCallVol = 0, avgPutVol = 0, contractCount = 0;
    const unusual = [];

    chains.forEach((chain, ci) => {
      if (!chain?.options?.option) return;
      const opts = Array.isArray(chain.options.option) ? chain.options.option : [chain.options.option];

      // Calculate average volume for unusual detection
      const vols = opts.map(o => o.volume || 0).filter(v => v > 0);
      const meanVol = vols.length ? vols.reduce((a,b)=>a+b,0)/vols.length : 1;

      opts.forEach(o => {
        const vol = o.volume || 0;
        const oi  = o.open_interest || 0;
        if (o.option_type === 'call') { totalCallVol += vol; totalCallOI += oi; }
        else                          { totalPutVol  += vol; totalPutOI  += oi; }
        contractCount++;

        // Flag unusual: volume > 3x average AND volume > 100
        if (vol > meanVol * 3 && vol > 100) {
          unusual.push({
            exp: dates[ci],
            strike: o.strike,
            type: o.option_type,
            volume: vol,
            oi: oi,
            ratio: vol > 0 && oi > 0 ? (vol/oi).toFixed(2) : 'N/A',
            volRatio: (vol/meanVol).toFixed(1)+'x',
            itm: o.in_the_money || false
          });
        }
      });
    });

    // Sort unusual by volume descending, take top 5
    unusual.sort((a,b) => b.volume - a.volume);
    const topUnusual = unusual.slice(0, 5);

    // Put/Call ratio (volume-based)
    const pcRatio = totalCallVol > 0 ? (totalPutVol / totalCallVol).toFixed(2) : 'N/A';
    const totalVol = totalCallVol + totalPutVol;

    // Sentiment score 0-3
    let flowScore = 0;
    const pcNum = parseFloat(pcRatio);
    if (!isNaN(pcNum)) {
      if (pcNum < 0.7)  flowScore += 2; // very bullish
      else if (pcNum < 1.0) flowScore += 1; // mildly bullish
    }
    if (topUnusual.length > 0) {
      const bullSweeps = topUnusual.filter(u => u.type === 'call').length;
      if (bullSweeps >= topUnusual.length * 0.6) flowScore += 1;
    }

    res.json({
      symbol: sym,
      pcRatio,
      totalCallVol,
      totalPutVol,
      totalVol,
      totalCallOI,
      totalPutOI,
      unusualCount: unusual.length,
      topUnusual: topUnusual,
      flowScore,         // 0=bearish, 1=neutral, 2=bullish, 3=very bullish
      sentiment: flowScore >= 2 ? 'bullish' : flowScore === 1 ? 'neutral' : 'bearish',
      timestamp: Date.now()
    });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Batch options flow for multiple symbols ───────────────────────────────────
app.get('/options-batch', async (req, res) => {
  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols required' });
  if (!TRADIER_TOKEN) return res.status(503).json({ error: 'Tradier token not configured' });

  const syms = symbols.toUpperCase().split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
  const results = {};

  // Process 3 at a time to respect Tradier rate limits
  for (let i = 0; i < syms.length; i += 3) {
    const group = syms.slice(i, i + 3);
    const groupResults = await Promise.all(group.map(async sym => {
      try {
        const resp = await fetch(`http://localhost:${PORT}/options?symbol=${sym}`);
        const data = await resp.json();
        return { sym, data };
      } catch(e) {
        return { sym, data: nullFlow(sym) };
      }
    }));
    groupResults.forEach(r => results[r.sym] = r.data);
    if (i + 3 < syms.length) await sleep(500);
  }

  res.json({ results, timestamp: Date.now() });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function nullFlow(sym) {
  return { symbol: sym, pcRatio: 'N/A', totalCallVol: 0, totalPutVol: 0, totalVol: 0, unusualCount: 0, topUnusual: [], flowScore: 1, sentiment: 'neutral' };
}

function tradierGet(endpoint) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.tradier.com',
      path: endpoint,
      headers: {
        'Authorization': `Bearer ${TRADIER_TOKEN}`,
        'Accept': 'application/json'
      }
    };
    https.get(opts, (r) => {
      let raw = '';
      r.on('data', c => raw += c);
      r.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function fetchFromYahoo(sym, interval, range, cb) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}`;
  const opts = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://finance.yahoo.com/',
      'Origin': 'https://finance.yahoo.com'
    }
  };
  const req = https.get(url, opts, (yfRes) => {
    let raw = '';
    yfRes.on('data', chunk => raw += chunk);
    yfRes.on('end', () => {
      try {
        const parsed = JSON.parse(raw);
        const result = parsed?.chart?.result?.[0];
        if (!result) return cb('no result from Yahoo');
        const q = result.indicators?.quote?.[0];
        if (!q?.close) return cb('no quote data');
        let last = q.close.find(v => v != null) || 0;
        const closes  = q.close.map(v  => { if (v  != null) last = v; return last; });
        const highs   = (q.high   || []).map((v, i) => v  || closes[i]);
        const lows    = (q.low    || []).map((v, i) => v  || closes[i]);
        const volumes = (q.volume || []).map(v => v || 0);
        const ts      = result.timestamp || [];
        const labels  = ts.slice(-closes.length).map(t =>
          new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        );
        cb(null, { closes, highs, lows, volumes, labels });
      } catch(e) { cb('parse error: ' + e.message); }
    });
  });
  req.on('error', e => cb('fetch error: ' + e.message));
  req.setTimeout(8000, () => { req.destroy(); cb('timeout'); });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, HOST, () => console.log(`MA Cross + Options Flow server on ${HOST}:${PORT}`));
