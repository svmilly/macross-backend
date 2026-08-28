# news/

Catalyst/news feed, using Finnhub's company-news API. Isolated from Tradier
and the execution module — own env var, no shared credentials.

## Setup

1. Get a free Finnhub API key: https://finnhub.io/register
2. Set `FINNHUB_API_KEY` in Railway → Variables.
3. Redeploy. Once set, the app:
   - Mounts `GET /api/news?ticker=SYM` (on-demand, any ticker)
   - Mounts `GET /api/news/watchlist` (cached feed for the screener's watchlist)
   - Starts a background refresh loop for the watchlist, spaced out to stay
     under Finnhub's free-tier 60 calls/min limit

If `FINNHUB_API_KEY` isn't set, these routes simply aren't mounted — the
rest of the app is unaffected.

## Rate limits

The watchlist (58 tickers) is refreshed one ticker every 2 seconds — a full
cycle takes ~2 minutes — then the whole cycle repeats every 20 minutes.
That's ~30 calls/min at peak, comfortably under the 60/min free tier, with
room for on-demand searches from the dashboard at the same time.

## Cache

In-memory only — resets on deploy or restart. Fine for a same-day catalyst
feed; not meant as a historical news archive. On-demand ticker searches are
cached for 5 minutes to avoid burning through the rate limit on repeated
searches for the same symbol.

## Sentiment

Finnhub's free company-news endpoint does not include sentiment scores —
that's a separate (often paid) endpoint. The `sentiment` field on each
article is currently always `null`; do not assume it's populated.

## Dashboard

A "News" tab was added to the screener dashboard (`server.js` →
`SCREENER_HTML`). It shows the watchlist feed by default, auto-refreshing
every 2 minutes, with a manual ticker search for any symbol not on the
watchlist.
