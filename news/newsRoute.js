// news/newsRoute.js
//
// Express router for the news/catalyst feed.
//
// GET /api/news?ticker=AAPL          — on-demand lookup for any ticker
// GET /api/news/watchlist            — cached news for the whole watchlist
//                                       (populated by the background refresh
//                                       loop started in server.js)

const express = require('express');
const { fetchCompanyNews, getCachedNews, getAllCachedNews } = require('./finnhubNews');

// Simple short-lived cache for on-demand lookups, separate from the
// watchlist cache — keeps a manual "search any ticker" from burning through
// the rate limit if someone searches the same symbol repeatedly.
const adHocCache = new Map(); // ticker -> { articles, updatedAt }
const AD_HOC_TTL_MS = 5 * 60 * 1000;

module.exports = function () {
  const router = express.Router();

  router.get('/news', async (req, res) => {
    const ticker = (req.query.ticker || '').toUpperCase().trim();
    if (!ticker) {
      return res.status(400).json({ error: 'ticker query param is required' });
    }

    const cached = adHocCache.get(ticker);
    if (cached && Date.now() - cached.updatedAt < AD_HOC_TTL_MS) {
      return res.json({ ticker, articles: cached.articles, cached: true, updatedAt: cached.updatedAt });
    }

    // Fall back to the watchlist cache if this ticker happens to be on it —
    // avoids an extra Finnhub call entirely.
    const watchlistHit = getCachedNews(ticker);
    if (watchlistHit) {
      return res.json({ ticker, articles: watchlistHit.articles, cached: true, updatedAt: watchlistHit.updatedAt });
    }

    try {
      const articles = await fetchCompanyNews(ticker, { days: 3 });
      adHocCache.set(ticker, { articles, updatedAt: Date.now() });
      res.json({ ticker, articles, cached: false, updatedAt: Date.now() });
    } catch (err) {
      const message = err.response?.data || { message: err.message };
      res.status(500).json({ error: message });
    }
  });

  router.get('/news/watchlist', (req, res) => {
    res.json(getAllCachedNews());
  });

  return router;
};
