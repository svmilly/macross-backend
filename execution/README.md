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

## Signal detection: server-side, not client-side (signalScanner.js)

**This replaced an earlier, broken design** — worth understanding why, since it explains a real gap that went unnoticed for a while. The original approach had the dashboard's own `addLog()` POST each detected crossover to `/api/signals` via `postSignalToBackend()`, whenever `detectCross()` fired on live data. Two problems with that, discovered only after checking real usage:

1. **Detection only ran while a browser tab was open.** If nobody had the dashboard open, nothing got scanned or logged — the resolver and stats pipeline had nothing to work with, no matter how correct their own logic was.
2. **Even with a tab open, only ONE timeframe was ever scanned** — whichever one was currently selected (`runScan()` uses `currentTF`). The other five timeframes were completely dormant unless someone manually switched to and stayed on each one. A week of the dashboard being closed produced exactly zero new signals, confirmed by comparing `/api/signals/stats` calls a week apart with byte-identical totals.

`signalScanner.js` now runs the exact same detection math **server-side, continuously, across all 6 timeframes**, independent of any browser. It's a faithful line-for-line port of the dashboard's own `smaArr`/`detectCross`/`scoreConviction`/`buildStock` functions — not a reimplementation with different behavior — so server-side and client-side detection agree on what counts as a signal. It fetches all 58 tickers per timeframe (bounded concurrency, ~10 at a time against Yahoo), tracks each ticker's last-seen signal per timeframe in memory (mirroring the dashboard's own `prev` map, just one per timeframe instead of one shared across whichever tab was open), and logs to `signals` on every new/changed crossover using the same 1% stop / 2% target (2R) convention as before.

**The dashboard's `postSignalToBackend()` call was removed** (function left as an inert no-op stub) — having both client and server post the same crossover would double-log every signal and skew your win-rate stats.

**Runs automatically whenever `DATABASE_URL` is set** — no separate flag, same pattern as the resolver/position-monitor/signal-watcher. A full 6-timeframe × 58-ticker cycle involves ~350 Yahoo fetches and can take a few minutes; cycles run back-to-back with at least a 60-second gap, never overlapping.

**Known limitations, stated plainly:**
- In-memory "last signal" state resets on server restart — a restart could cause the very next crossover-consistent state to be re-logged as "new" even if it isn't, for one cycle. Minor, self-correcting.
- Still uses Yahoo's unofficial API — same caveat as everywhere else in this app.
- No per-timeframe stagger — all 6 timeframes run in the same sequential loop, so a slow Yahoo response on one timeframe delays the next.

**What this means in practice:** with `AUTO_TRADE_ENABLED=true`, signals now fire and can trigger real (sandbox, unless `TRADIER_ENV=live`) orders **at any time, on any timeframe, whether or not anyone has the dashboard open.** This is a meaningfully bigger change in responsibility than before — previously the dashboard being closed acted as an accidental safety net; that's gone now. Treat this as something to actively monitor, not something to enable and forget.

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
- Market-hours guard now exists (see Guardrails).
- Only recognizes `buy`/`sell_short` (equity) and `buy_to_open`/
  `sell_to_open` (option) as positions it knows how to close. Anything else
  is left alone.
- A failed close backs off 10 minutes before retrying, but there's no
  alerting — watch Deploy Logs for "not filled — leaving open".

## Guardrails (guardrails.js)

Added after auto-trade was found running unsupervised with stacked and
opposing positions. No schema changes required.

**Signal watcher (entries)** — checked in this order for each new signal:

1. `setup_type` not in `AUTO_TRADE_SETUP_TYPES` → marked seen, skipped.
2. `tf` not in `AUTO_TRADE_TIMEFRAMES` → marked seen, skipped.
3. **Older than its max age** → marked seen, skipped. Runs even while
   `AUTO_TRADE_ENABLED` is off, so a backlog can never fire all at once
   when auto-trade is turned back on.
4. Conviction below `MIN_CONVICTION_TO_TRADE` → `skipped_low_conviction`.
5. Auto-trade or trading disabled → left unmarked (step 3 expires it).
6. **Market not open** (Tradier `/markets/clock`, handles holidays; falls
   back to 9:30–16:00 ET weekdays) → left unmarked until open or stale.
7. **Daily cap reached** → logged `skipped_daily_cap`.
8. **Ticker already has an open or working position** (manual or auto) →
   logged `skipped_existing_position`.

Default max age per timeframe: 5m 10 min · 15m 30 min · 1h 90 min ·
4h 5 h · 1d 36 h · 1wk 72 h (unknown `tf`: 30 min).

| Var | Default | Notes |
|---|---|---|
| `AUTO_TRADE_TIMEFRAMES` | all six | e.g. `1h,4h,1d` |
| `AUTO_TRADE_MAX_AGE_MINUTES` | per-tf table above | one override for every timeframe |
| `AUTO_TRADE_MAX_PER_DAY` | `10` | entries per ET day; skipped/rejected/error rows don't count |
| `AUTO_TRADE_ALLOW_STACKING` | off | `true` allows multiple positions per ticker |

**Position monitor (exits):**

- Every cycle, options past their expiration date are marked closed with
  `close_reason='expired'` (no order sent).
- Stop/target checks only run while the market is open.
- A position is only marked closed when the closing order **fills**. A
  rejected/unfilled close leaves it open and backs off 10 minutes.
- Closing-order rows are written with `is_closed=true` so they never show
  as open positions. Same in `POST /api/close-position/:id`, which now
  returns `202 {closed:false}` if the close didn't fill.

**Still not handled:** loss limits (no P&L tracking), position sizing, and
short-timeframe signals paired with ~10 DTE contracts when
`AUTO_TRADE_ASSET_CLASS=option`.

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
- One-position-per-ticker and a daily trade cap now exist (see Guardrails).
  There is still no loss limit.
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

## New: filtered strategy (ma_crossover_filtered) — runs alongside the original

After the original MA13/48 crossover strategy showed a real, substantial-sample negative result (553 signals, 12.8% win rate, -68.52 total R as of Sept 15), `signalScanner.js` now also computes a second, stricter strategy from the exact same cross event — logged under `setup_type: 'ma_crossover_filtered'` so it can be compared directly against the original via `/api/signals/stats` (grouped by `setup_type`).

**What's different about the filtered version:**
- **ADX(14) ≥ 22 required** — skips crossovers fired in choppy/ranging conditions, the main mechanism behind MA-crossover whipsaws. `ADX_MIN` in `signalScanner.js`.
- **Trend alignment** — price must sit on the correct side of a 100-period MA for the cross direction (bull cross needs price above it, bear needs below). This is a **same-timeframe long MA, not a genuinely separate higher timeframe** — a deliberate simplification to avoid doubling the Yahoo fetch load (~350 fetches/cycle already). If you want a true multi-timeframe trend filter later, that's a real, larger change, not a tweak.
- **ATR-based stop/target** instead of flat 1%/2% — `stop = entry ± 1.5×ATR(14)`, `target = entry ± 3×ATR(14)` (still 2:1 reward:risk, just scaled to each ticker's actual volatility instead of one-size-fits-all).

**Both strategies share the same trigger** — a stock either has a fresh MA13/48 cross or it doesn't; the filtered version just adds gates on top and, when it fires, is logged as a second, separate signal alongside the original. No extra Yahoo calls — both are computed from the same fetched OHLC.

**Safe by default**: `AUTO_TRADE_SETUP_TYPES` (in `signalWatcher.js`) still defaults to `ma_crossover` only, so `ma_crossover_filtered` signals get logged and can accumulate backtest data, but will **never auto-trade** unless you explicitly add it to that env var later.

**Data range extended for two timeframes**: daily went from 3mo→1y and weekly from 2y→5y, since the new 100-period trend MA needed more history than either range previously provided. This doesn't change the original MA13/48 cross detection at all — a wider trailing window feeding the same fixed-length SMA doesn't move that SMA's value at any given bar.

**Not a promise of better results** — this targets the specific, identifiable weaknesses the data showed (whipsaws, flat risk sizing), not a guarantee. Let both strategies accumulate real signals before drawing conclusions, same caution as before: daily needs ~21 days to resolve, weekly needs ~105.

## Status

Both `signalScanner.js` (detection) and everything in `execution/` are
fully wired into `server.js` and run automatically whenever
`DATABASE_URL` is set — nothing here is standalone/unmounted.
