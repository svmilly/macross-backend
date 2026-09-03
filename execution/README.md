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

**Manual contract picker (Trade tab):** the dashboard's Trade tab (Option
asset class) has two modes — "Auto-Select Contract" (as above) and
"Choose Specific Contract", which pulls real listed expirations/strikes
from Tradier live (via two new read-only routes,
`GET /api/option-expirations/:ticker` and
`GET /api/option-strikes/:ticker?expiration=YYYY-MM-DD`) so you can hand-pick
an exact contract instead of letting the resolver choose one. Submits via
the manual `execute-option-signal` endpoint below, not the auto one.

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

## Screener → signals wiring (the real detection path)

The dashboard's `addLog()` function — called every time `detectCross()`
flags a genuine new/changed MA crossover on **live data** — now POSTs to
`/api/signals` automatically, via `postSignalToBackend()`. This is the
first time real crossover detection (not a manual insert) reaches the
`signals` table, and from there the `AUTO_TRADE_ENABLED` watcher.

**Sim/demo mode is explicitly excluded.** When live data fails to load,
the dashboard falls back to `runSimulation()`, which generates fake
crossovers so the UI isn't empty. `addLog()` checks `isSimMode` and skips
the backend POST entirely for those — fake demo signals never reach the
database or the auto-trade watcher. Only signals from `runScan()`'s live
-data path (`isSimMode=false`) get logged.

**Stop/target convention:** a fixed 1% stop / 2% target (2R) off the
entry price, computed client-side at signal time — this is the "fixed R"
approach `signals.js`'s own top comment suggested as a fallback before
more sophisticated stop/target logic exists. Change `stopPct`/`targetPct`
in `postSignalToBackend()` if you want different levels.

**What this means in practice:** with `AUTO_TRADE_ENABLED=true`, leaving
the dashboard open (or otherwise triggering `runScan()`) on live data can
now place real (sandbox, unless `TRADIER_ENV=live`) orders with zero
further action from you. This was previously untested — every order in
this system so far came from a manual API call or a hand-inserted signal
row, never the actual screener. Treat the first live sessions with this
enabled as something to watch closely, not something to leave running
unattended.

## Auto-close (position monitor)

`execution/positionMonitor.js` runs on a 60-second interval and checks every
open position (`is_closed=false AND status='filled'`) against its
`stop_price`/`target_price`. When hit, it places the corresponding closing
order automatically and marks the position `is_closed=true` with a
`close_reason` of `'stop'` or `'target'`.

**Only positions with `direction` and at least one of `stop_price`/
`target_price` set are watched.** A position without these is placed but
never auto-closed — same as before this existed. `direction`/`stop_price`/
`target_price` are optional fields on `execute-signal`,
`execute-option-signal`, and `execute-option-signal-auto` — pass them
explicitly, or link a `signal_id` whose `signals` row already has
`stop_price`/`target_price` set (they'll be pulled automatically if you
don't pass your own).

**Options are watched via the UNDERLYING's price, not the option's own
premium.** `stop_price`/`target_price` follow the same convention as
`signals.js`/`resolver.js` — they're underlying-price levels the original
signal was built on. This monitor checks the underlying's quote and closes
the OPTION position when that underlying level is hit. It does **not**
track the option's own P&L or premium — a position could be watched
correctly by this logic while the option itself has moved very differently
than the underlying's % move would suggest (normal for options, given
delta/theta/vega), so don't expect stop/target hits here to correspond to
a specific dollar loss on the premium.

**Manual override:** `POST /api/close-position/:id` closes a specific open
position immediately, regardless of stop/target — useful for testing or an
emergency exit. `GET /api/open-positions` lists everything currently open
and being watched.

**Known limitations, stated plainly:**
- No market-hours guard — the monitor runs on its interval regardless of
  whether the market is open. Off-hours quote behavior against this logic
  is untested; treat that as an open question, not something we've verified
  is safe.
- Only recognizes `buy`/`sell_short` (equity) and `buy_to_open`/
  `sell_to_open` (option) as positions it knows how to close. Anything else
  is left alone.
- One closing attempt per hit per cycle — if the close order itself fails
  (rejected, network error), the position stays open and gets picked up
  again on the next 60s cycle. There's no backoff or alerting if it keeps
  failing.

## Signal → execution wiring

`execution/signalWatcher.js` polls the `signals` table every 30 seconds for
rows where `auto_traded=false`. When it finds one:

1. If `setup_type` isn't in `AUTO_TRADE_SETUP_TYPES` (default:
   `ma_crossover` only), it's marked `auto_traded=true` and skipped
   silently — no order, no log row.
2. If `conviction_score` is below `MIN_CONVICTION_TO_TRADE`, it's logged as
   `skipped_low_conviction` (same as the manual endpoints) and marked
   `auto_traded=true`.
3. Otherwise, **only if `AUTO_TRADE_ENABLED=true` AND `TRADING_ENABLED=true`**,
   it places an entry — equity or option depending on `AUTO_TRADE_ASSET_CLASS`
   — using the signal's `direction`, `stop_price`, and `target_price`
   (so the position monitor above can watch it), then marks the signal
   `auto_traded=true`.

**`AUTO_TRADE_ENABLED` is deliberately separate from `TRADING_ENABLED`.**
You can leave `TRADING_ENABLED=true` for manual testing via the HTTP
endpoints without every new signal firing an order on its own — nothing
auto-fires until `AUTO_TRADE_ENABLED=true` is set explicitly. If
`AUTO_TRADE_ENABLED` isn't `'true'`, matching signals are simply left
un-marked (`auto_traded` stays `false`) so they'll still be picked up once
you do turn it on, rather than being silently skipped forever.

Env vars (all optional except the two enable flags):

| Var | Default | Notes |
|---|---|---|
| `AUTO_TRADE_ENABLED` | unset (off) | must be exactly `'true'` |
| `AUTO_TRADE_ASSET_CLASS` | `equity` | or `option` |
| `AUTO_TRADE_SETUP_TYPES` | `ma_crossover` | comma-separated allowlist |
| `AUTO_TRADE_QUANTITY` | `1` | fixed size per signal — no position sizing logic yet |
| `AUTO_TRADE_TYPE` | `swing_short` | options only: `0dte`\|`swing_short`\|`swing_long` |
| `AUTO_TRADE_PCT_OTM` | `0.025` | options only |

**Known limitations, stated plainly:**
- Fixed quantity per trade — no position sizing based on conviction,
  account equity, or risk. This is genuinely naive; treat
  `AUTO_TRADE_QUANTITY` as a placeholder, not a real sizing model.
- No check for whether you already have an open position on the same
  ticker — a second signal on a ticker you're already in will open a
  second position, not add to or skip it.
- No daily/weekly trade-count or loss limits. Nothing stops it from firing
  repeatedly through a bad session.
- This has NOT been tested end-to-end with a real signal flowing through
  live signal generation → auto-trade → auto-close. Each piece has been
  tested individually (manual order placement, contract resolution,
  fill-confirmation) but the full automated loop has not been observed
  running against live signals yet.

## Recommended rollout for auto-close + wiring

1. Leave `AUTO_TRADE_ENABLED` unset. Manually place a position via
   `execute-signal`/`execute-option-signal(-auto)` with `direction` +
   `stop_price`/`target_price` set, and watch the position monitor close it
   when the level is hit (or use `close-position/:id` to force it and
   confirm the mechanics work).
2. Once the monitor is trusted, set `AUTO_TRADE_ENABLED=true` with a low
   `AUTO_TRADE_QUANTITY` (1) and watch it fire on real signals for a while
   before trusting it unsupervised.
3. Given the below-50%-win-rate pattern already found in your Tradezella
   history, treat this as something to watch closely rather than something
   to leave running unattended — especially before any position-sizing or
   loss-limit logic exists.

## Recommended rollout

1. Run with `TRADIER_ENV=sandbox` against live signals for a few weeks.
2. Compare fills against your signal-tracking backtest expectancy.
3. Only then consider `TRADIER_ENV=live` with `TRADING_ENABLED=true`, and
   start with small size.

## Status

Not yet wired into `server.js` — added as a standalone module. Mount it
deliberately when ready.
