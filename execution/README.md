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

## Recommended rollout

1. Run with `TRADIER_ENV=sandbox` against live signals for a few weeks.
2. Compare fills against your signal-tracking backtest expectancy.
3. Only then consider `TRADIER_ENV=live` with `TRADING_ENABLED=true`, and
   start with small size.

## Status

Not yet wired into `server.js` — added as a standalone module. Mount it
deliberately when ready.
