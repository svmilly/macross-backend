const express = require('express');
const https   = require('https');
const app     = express();
const PORT    = process.env.PORT || 3000;

// ── CORS: allow requests from any browser ─────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'MA Cross + VWAP data server running' });
});

// ── Quote endpoint: /quote?symbol=AAPL&interval=1d&range=3mo ─────────────────
app.get('/quote', (req, res) => {
  const { symbol, interval = '1d', range = '3mo' } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: 'symbol is required' });
  }

  const sym = symbol.toUpperCase().trim();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}`;

  const options = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://finance.yahoo.com/',
    }
  };

  https.get(url, options, (yfRes) => {
    let data = '';
    yfRes.on('data', chunk => data += chunk);
    yfRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        // Check Yahoo returned valid data
        const result = parsed?.chart?.result?.[0];
        if (!result) {
          return res.status(502).json({ error: 'No data from Yahoo Finance', raw: parsed?.chart?.error });
        }
        res.json(parsed);
      } catch (e) {
        res.status(502).json({ error: 'Failed to parse Yahoo Finance response' });
      }
    });
  }).on('error', (e) => {
    res.status(502).json({ error: 'Failed to reach Yahoo Finance', detail: e.message });
  });
});

// ── Batch endpoint: /batch?symbols=AAPL,MSFT,NVDA&interval=1d&range=3mo ──────
// Fetches multiple symbols concurrently, returns all results in one response
app.get('/batch', async (req, res) => {
  const { symbols, interval = '1d', range = '3mo' } = req.query;

  if (!symbols) {
    return res.status(400).json({ error: 'symbols is required (comma-separated)' });
  }

  const syms = symbols.toUpperCase().split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);

  const fetchOne = (sym) => new Promise((resolve) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}`;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://finance.yahoo.com/',
      }
    };

    https.get(url, options, (yfRes) => {
      let data = '';
      yfRes.on('data', chunk => data += chunk);
      yfRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const result = parsed?.chart?.result?.[0];
          if (!result) return resolve({ sym, error: 'no data' });
          const q = result.indicators?.quote?.[0];
          if (!q?.close) return resolve({ sym, error: 'no quotes' });

          // Fill null values with previous close
          let last = q.close.find(v => v != null) || 0;
          const closes  = q.close.map(v  => { if (v  != null) last = v;  return last; });
          const highs    = (q.high   || []).map((v, i) => v  || closes[i]);
          const lows     = (q.low    || []).map((v, i) => v  || closes[i]);
          const volumes  = (q.volume || []).map(v => v || 0);
          const timestamps = result.timestamp || [];
          const labels   = timestamps.slice(-closes.length).map(t =>
            new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          );

          resolve({ sym, closes, highs, lows, volumes, labels });
        } catch (e) {
          resolve({ sym, error: 'parse error' });
        }
      });
    }).on('error', () => resolve({ sym, error: 'fetch error' }));
  });

  try {
    // Stagger requests slightly to avoid rate limiting
    const results = {};
    for (let i = 0; i < syms.length; i++) {
      if (i > 0 && i % 10 === 0) await sleep(300); // brief pause every 10
      const r = await fetchOne(syms[i]);
      results[r.sym] = r.error ? { error: r.error } : {
        closes: r.closes, highs: r.highs, lows: r.lows,
        volumes: r.volumes, labels: r.labels
      };
    }
    res.json({ results, timestamp: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, () => {
  console.log(`MA Cross server running on port ${PORT}`);
});
