# brief/

Premarket "game plan" — reuses `execution/tradierOrders.js` (quotes,
contract resolution) and `news/finnhubNews.js` (headlines). No new
credentials; requires both `TRADIER_TRADING_TOKEN` and `FINNHUB_API_KEY`
to already be set, since it needs both.

## What it generates, per ticker

- Last price vs prior close (the gap %)
- Top 3 news headlines from the last day
- What contract the auto-resolver (`resolveContract`) would pick today,
  both bullish (call) and bearish (put), at `swing_short` (~10 DTE, 2.5%
  OTM) — same logic used by `execute-option-signal-auto`

## Core brief (auto-scheduled)

`CORE_TICKERS = ['SPY','QQQ','IWM','TSLA']` in `dailyBrief.js` — edit that
array to change which tickers get the automatic 9am brief.

Generation is checked every 60 seconds; it fires once per weekday at/after
9:00 AM ET (`America/New_York`, so this correctly handles DST without any
extra config) and is cached in memory until the next weekday. A server
restart after 9am will catch up and generate immediately rather than
waiting for the next calendar day.

`GET /api/premarket-brief` returns the cached brief, or
`{generated:false, message:...}` if it hasn't run yet today.
`GET /api/premarket-brief?force=1` regenerates immediately, bypassing the
schedule — useful for testing without waiting for 9am.

## On-demand (any ticker)

`GET /api/premarket-brief/:ticker` builds the same game-plan format for
any ticker, live, not cached. This is what the dashboard's ticker search
in the Brief tab calls.

## Known limitations

- In-memory cache only — resets on deploy/restart (a restart shortly after
  9am will regenerate immediately via the startup catch-up check, but a
  restart at, say, 2pm won't retroactively show you what the 9am brief
  said).
- No MA-crossover/trend state included — that logic lives client-side in
  the dashboard's `detectCross()` and isn't duplicated here. The brief is
  price-gap + news + contract-idea only, not a technical read.
- `resolveContract` calls (2 per ticker, bull + bear) add real latency —
  the core brief for 4 tickers involves 8 options-chain lookups plus 4
  quotes plus 4 news calls. Expect a few seconds to generate, not
  instant.
