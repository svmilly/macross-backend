const express = require('express');
const https   = require('https');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;
const HOST    = '0.0.0.0';

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Serve screener.html at root and /screener ─────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'screener.html'));
});

app.get('/screener', (req, res) => {
  res.sendFile(path.join(__dirname, 'screener.html'));
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'MA Cross + VWAP server is running' });
});

// ── Single quote endpoint ─────────────────────────────────────────────────────
app.get('/quote', (req, res) => {
  const { symbol, interval = '1d', range = '3mo' } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const sym = symbol.toUpperCase().trim();
  fetchFromYahoo(sym, interval, range, (err, data) => {
    if (err) return res.status(502).json({ error: err });
    res.json(data);
  });
});

// ── Batch endpoint ────────────────────────────────────────────────────────────
app.get('/batch', async (req, res) => {
  const { symbols, interval = '1d', range = '3mo' } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols required' });
  const syms = symbols.toUpperCase().split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
  const results = {};
  for (let i = 0; i < syms.length; i++) {
    if (i > 0 && i % 10 === 0) await sleep(400);
    await new Promise(resolve => {
      fetchFromYahoo(syms[i], interval, range, (err, data) => {
        results[syms[i]] = err ? { error: err } : data;
        resolve();
      });
    });
  }
  res.json({ results, timestamp: Date.now() });
});

// ── Yahoo Finance fetcher ─────────────────────────────────────────────────────
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
  https.get(url, opts, (yfRes) => {
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
        const closes  = q.close.map(v => { if (v != null) last = v; return last; });
        const highs   = (q.high   || []).map((v, i) => v  || closes[i]);
        const lows    = (q.low    || []).map((v, i) => v  || closes[i]);
        const volumes = (q.volume || []).map(v => v || 0);
        const ts      = result.timestamp || [];
        const labels  = ts.slice(-closes.length).map(t =>
          new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        );
        cb(null, { closes, highs, lows, volumes, labels });
      } catch(e) {
        cb('parse error: ' + e.message);
      }
    });
  }).on('error', e => cb('fetch error: ' + e.message));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`MA Cross server running on ${HOST}:${PORT}`);
});
