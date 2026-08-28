# execution/

Order-placement module for macross-backend, using Tradier's brokerage API.
Kept isolated from the read-only market-data client used by the screener
and Level Ladder dashboard.

## Why isolated

- Separate env vars/token scope from the market-data Tradier client, so a
  leak or bug in the screener code can't touch a token with trading access.
- Routes only mount / only function when `TRADING_ENABLED=true` — inert by
  default.

## Setup

1. Create a **separate** Tradier API token scoped for trading (not the one
   used for market data), from your Tradier account dashboard.
2. Set env vars (Railway → Variables):
   - `TRADIER_ENV` — `sandbox` (default, recommended to start) or `live`
   - `TRADIER_TRADING_TOKEN` — the trading-scoped token
   - `TRADIER_ACCOUNT_ID` — your Tradier brokerage account id
   - `TRADING_ENABLED` — `true` to allow order placement; unset/false to
     keep the endpoint inert
   - `MIN_CONVICTION_TO_TRADE` — optional, defaults to 5

3. Mount the router in `server.js` only where you want it live:

   ```js
   const executeRoute = require('./execution/executeRoute');
   app.use('/api', executeRoute);
   ```

## Order logging

Every call to `POST /api/execute-signal` — success, skip, or failure — is
logged to the `executed_orders` table (see `schema.sql`), linked to
`signal_id` when provided. Run `schema.sql` again against your Railway
Postgres instance to pick up the new table if it doesn't exist yet; `CREATE
TABLE IF NOT EXISTS` makes it safe to re-run.

Look up what's actually been sent to Tradier with:

```
GET /api/executed-orders
GET /api/executed-orders?signal_id=123
GET /api/executed-orders?ticker=AAPL&since=2026-08-01
```

## Fill confirmation

Placing an order only confirms Tradier *accepted* it, not that it filled.
`execute-signal` and `execute-option-signal` now poll the order (up to 5
times, 1s apart) after placement and log the real terminal status
(`filled`, `rejected`, `canceled`, `expired`) to `executed_orders` — not
just the initial accepted response. If it hasn't reached a terminal state
within that window, the logged status reflects whatever was last observed
(e.g. `pending`/`open`) rather than being reported as filled.

This matters most for options: a `sell_to_close` sent against a position
that never actually filled will be rejected by Tradier, as seen in early
sandbox testing here.

## Auto contract selection (0DTE / swing)

`execute-option-signal-auto` picks the contract for you instead of
requiring an explicit expiration/strike:

- `direction: 'bull'` → call, `direction: 'bear'` → put
- `tradeType: '0dte' | 'swing_short' | 'swing_long'` maps to a target
  days-to-expiration (0 / ~10 / ~35 respectively — see `TRADE_TYPE_DTE` in
  `tradierOrders.js` to tune), then picks the closest **actual listed**
  expiration from Tradier's chain — never a computed date that might not
  exist.
- Strike is picked at `pctOtm` (default 2.5%) out-of-the-money from the
  live quote, snapped to the nearest **actual listed strike**.

**0DTE caveat:** most tickers don't list daily expirations — this is
mainly available on SPY, QQQ, and a handful of other high-volume names. If
you request `0dte` on a name without same-day options, the resolver falls
back to the nearest available expiration and the response's
`zeroDteUnavailable: true` flag tells you that happened — check for that
flag rather than assuming `0dte` always means today.

**Preview before trading:** `GET /api/resolve-contract?underlying=AAPL&direction=bull&tradeType=swing_short`
returns what would be selected (expiration, strike, occSymbol, spot price)
without placing an order — useful for sanity-checking the selection logic
before wiring it to real signals. Doesn't require `TRADING_ENABLED`.

## Options support

`execute-option-signal` places **entry** orders only (`buy_to_open` /
`sell_to_open`). There is currently **no automatic exit/close logic** —
nothing in this codebase watches an open option position and closes it
when a stop or target is hit. `resolver.js` marks signals win/loss/scratch
for backtesting stats, but that only updates the database; it does not
place a closing order.

Building auto-close is a separate, deliberate piece of work — treat any
option position opened through this route as something you're watching
and closing manually until that's built.

## Recommended rollout

1. Run with `TRADIER_ENV=sandbox` against live signals for a few weeks.
2. Compare fills against your signal-tracking backtest expectancy.
3. Only then consider `TRADIER_ENV=live` with `TRADING_ENABLED=true`, and
   start with small size.

## Status

Not yet wired into `server.js` — added as a standalone module. Mount it
deliberately when ready.
