// news/finnhubNews.js
//
// Finnhub company-news client. Isolated module, own env var
// (FINNHUB_API_KEY), separate from the Tradier client used elsewhere.
//
// Free tier: 60 calls/min. A 58-ticker watchlist can't be refreshed in a
// single burst without risking the rate limit, so watchlist refreshes are
// spaced out by refreshWatchlistCache() rather than fired all at once.

const axios = require('axios');

const FINNHUB_BASE = 'https://finnhub.io/api/v1';

function apiKey() {
  return process.env.FINNHUB_API_KEY;
}

function client() {
  const key = apiKey();
  if (!key) {
    throw new Error('FINNHUB_API_KEY is not set');
  }
  return axios.create({ baseURL: FINNHUB_BASE });
}

function toYMD(date) {
  return date.toISOString().slice(0, 10);
}

// Fetch company news for a single ticker over the last `days` days.
// Returns Finnhub's raw article array, most-recent-first is NOT guaranteed
// by their API, so we sort by datetime descending here.
async function fetchCompanyNews(ticker, { days = 3 } = {}) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  const { data } = await client().get('/company-news', {
    params: {
      symbol: ticker.toUpperCase(),
      from: toYMD(from),
      to: toYMD(to),
      token: apiKey(),
    },
  });

  const articles = Array.isArray(data) ? data : [];
  return articles
    .map((a) => ({
      ticker: ticker.toUpperCase(),
      headline: a.headline,
      summary: a.summary,
      source: a.source,
      url: a.url,
      image: a.image,
      datetime: a.datetime ? a.datetime * 1000 : null, // Finnhub gives unix seconds
      // Finnhub's free company-news endpoint doesn't include sentiment —
      // that's a separate (often paid-tier) endpoint. Leave null rather
      // than fabricate a score.
      sentiment: null,
    }))
    .sort((a, b) => (b.datetime || 0) - (a.datetime || 0));
}

// ── Watchlist cache ──────────────────────────────────────────────────────
// In-memory only — resets on deploy/restart, which is fine for a same-day
// catalyst feed.
const watchlistCache = new Map(); // ticker -> { articles, updatedAt }
let refreshInFlight = false;

function getCachedNews(ticker) {
  return watchlistCache.get(ticker.toUpperCase()) || null;
}

function getAllCachedNews() {
  const out = {};
  for (const [ticker, entry] of watchlistCache.entries()) {
    out[ticker] = entry;
  }
  return out;
}

// Refresh the watchlist cache one ticker at a time, spaced by delayMs, to
// stay well under Finnhub's 60/min free-tier limit even with a 58-ticker
// watchlist (58 calls spread over ~2 minutes at 2s/call is ~30 calls/min).
async function refreshWatchlistCache(tickers, { delayMs = 2000, days = 3 } = {}) {
  if (refreshInFlight) return; // don't stack overlapping refresh cycles
  refreshInFlight = true;
  try {
    for (const ticker of tickers) {
      try {
        const articles = await fetchCompanyNews(ticker, { days });
        watchlistCache.set(ticker.toUpperCase(), {
          articles,
          updatedAt: Date.now(),
        });
      } catch (err) {
        console.error(`Finnhub news refresh failed for ${ticker}:`, err.message);
        // Leave any previously cached data in place rather than clearing it.
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  } finally {
    refreshInFlight = false;
  }
}

module.exports = {
  fetchCompanyNews,
  getCachedNews,
  getAllCachedNews,
  refreshWatchlistCache,
};
