// execution/signalWatcher.js
//
// Polls the signals table for new rows and, if AUTO_TRADE_ENABLED=true,
// automatically places an entry order for signals that clear the
// conviction threshold and match an allowed setup_type.
//
// This is a SEPARATE flag from TRADING_ENABLED — TRADING_ENABLED must
// also be true for anything to actually place, but AUTO_TRADE_ENABLED is
// what decides whether new signals fire orders on their own vs. requiring
// a manual call to /api/execute-signal. Keeping these separate lets you
// test manual order placement without every new signal firing an order.
//
// Required env vars for this to do anything:
//   AUTO_TRADE_ENABLED        must be exactly 'true'
//   TRADING_ENABLED           must also be 'true' (checked again at order time)
//
// Optional config:
//   AUTO_TRADE_ASSET_CLASS    'equity' (default) or 'option'
//   AUTO_TRADE_SETUP_TYPES    comma-separated allowlist, default 'ma_crossover'
//   AUTO_TRADE_QUANTITY       default 1
//   AUTO_TRADE_TYPE           for options only: '0dte'|'swing_short'|'swing_long', default 'swing_short'
//   AUTO_TRADE_PCT_OTM        for options only: default 0.025
//   MIN_CONVICTION_TO_TRADE   shared with executeRoute.js, default 5

const {
  placeEquityOrder,
  placeOptionOrder,
  waitForFill,
  resolveContract,
  tradingEnabled,
} = require('./tradierOrders');

const MIN_CONVICTION = Number(process.env.MIN_CONVICTION_TO_TRADE || 5);
const ASSET_CLASS = process.env.AUTO_TRADE_ASSET_CLASS === 'option' ? 'option' : 'equity';
const SETUP_TYPES = (process.env.AUTO_TRADE_SETUP_TYPES || 'ma_crossover')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const QUANTITY = Number(process.env.AUTO_TRADE_QUANTITY || 1);
const TRADE_TYPE = process.env.AUTO_TRADE_TYPE || 'swing_short';
const PCT_OTM = process.env.AUTO_TRADE_PCT_OTM ? Number(process.env.AUTO_TRADE_PCT_OTM) : undefined;

let watcherInFlight = false;

async function logOrder(pool, fields) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO executed_orders
        (signal_id, tradier_order_id, ticker, side, quantity, order_type,
         status, tradier_env, conviction_score, error, raw_response,
         asset_class, occ_symbol, strike, expiration, option_type,
         direction, stop_price, target_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        fields.signal_id ?? null,
        fields.tradier_order_id ?? null,
        fields.ticker,
        fields.side,
        fields.quantity,
        fields.order_type ?? 'market',
        fields.status ?? null,
        process.env.TRADIER_ENV === 'live' ? 'live' : 'sandbox',
        fields.conviction_score ?? null,
        fields.error ?? null,
        fields.raw_response ? JSON.stringify(fields.raw_response) : null,
        fields.asset_class ?? 'equity',
        fields.occ_symbol ?? null,
        fields.strike ?? null,
        fields.expiration ?? null,
        fields.option_type ?? null,
        fields.direction ?? null,
        fields.stop_price ?? null,
        fields.target_price ?? null,
      ]
    );
  } catch (err) {
    console.error('signalWatcher: failed to log executed_order:', err.message);
  }
}

async function markAutoTraded(pool, signalId) {
  try {
    await pool.query('UPDATE signals SET auto_traded = true WHERE id = $1', [signalId]);
  } catch (err) {
    console.error(`signalWatcher: failed to mark signal ${signalId} auto_traded:`, err.message);
  }
}

async function processSignal(pool, signal) {
  const { id, ticker, setup_type, conviction_score, direction, stop_price, target_price } = signal;

  if (!SETUP_TYPES.includes(setup_type)) {
    await markAutoTraded(pool, id); // not an allowed setup — mark seen, skip silently
    return;
  }

  if (conviction_score != null && conviction_score < MIN_CONVICTION) {
    await logOrder(pool, {
      signal_id: id,
      ticker,
      side: direction === 'long' ? 'buy' : 'sell_short',
      quantity: QUANTITY,
      status: 'skipped_low_conviction',
      conviction_score,
    });
    await markAutoTraded(pool, id);
    return;
  }

  if (!process.env.AUTO_TRADE_ENABLED || process.env.AUTO_TRADE_ENABLED !== 'true' || !tradingEnabled()) {
    // Auto-trading isn't actually turned on — don't mark as traded, so a
    // future run (once it IS enabled) can still act on this signal. This
    // branch mainly exists so the watcher can run harmlessly with logging
    // even before you're ready to flip it on.
    return;
  }

  try {
    if (ASSET_CLASS === 'equity') {
      const side = direction === 'long' ? 'buy' : 'sell_short';
      const order = await placeEquityOrder({ symbol: ticker, side, quantity: QUANTITY, type: 'market' });
      const { status, order: confirmedOrder } =
        order?.id != null ? await waitForFill(order.id) : { status: order?.status, order };

      await logOrder(pool, {
        signal_id: id,
        tradier_order_id: order?.id != null ? String(order.id) : null,
        ticker,
        side,
        quantity: QUANTITY,
        status,
        conviction_score,
        raw_response: confirmedOrder || order,
        direction,
        stop_price,
        target_price,
      });
    } else {
      const bullBear = direction === 'long' ? 'bull' : 'bear';
      const resolved = await resolveContract({ underlying: ticker, direction: bullBear, tradeType: TRADE_TYPE, pctOtm: PCT_OTM });
      const { order } = await placeOptionOrder({
        underlying: ticker,
        occSymbol: resolved.occSymbol,
        side: 'buy_to_open',
        quantity: QUANTITY,
        type: 'market',
      });
      const { status, order: confirmedOrder } =
        order?.id != null ? await waitForFill(order.id) : { status: order?.status, order };

      await logOrder(pool, {
        signal_id: id,
        tradier_order_id: order?.id != null ? String(order.id) : null,
        ticker,
        side: 'buy_to_open',
        quantity: QUANTITY,
        status,
        conviction_score,
        raw_response: confirmedOrder || order,
        asset_class: 'option',
        occ_symbol: resolved.occSymbol,
        strike: resolved.strike,
        expiration: resolved.expiration,
        option_type: resolved.optionType,
        direction,
        stop_price,
        target_price,
      });
    }
  } catch (err) {
    const errPayload = err.response?.data || { message: err.message };
    await logOrder(pool, {
      signal_id: id,
      ticker,
      side: direction === 'long' ? 'buy' : 'sell_short',
      quantity: QUANTITY,
      status: 'error',
      conviction_score,
      error: JSON.stringify(errPayload),
      asset_class: ASSET_CLASS,
    });
  }

  await markAutoTraded(pool, id);
}

async function checkForNewSignals(pool) {
  if (!pool || watcherInFlight) return;
  watcherInFlight = true;
  try {
    const result = await pool.query(
      `SELECT * FROM signals WHERE auto_traded = false ORDER BY created_at ASC LIMIT 20`
    );
    for (const signal of result.rows) {
      await processSignal(pool, signal);
    }
  } catch (err) {
    console.error('signalWatcher cycle failed:', err.message);
  } finally {
    watcherInFlight = false;
  }
}

function startSignalWatcher(pool, { intervalMs = 30 * 1000 } = {}) {
  checkForNewSignals(pool);
  return setInterval(() => checkForNewSignals(pool), intervalMs);
}

module.exports = { startSignalWatcher, checkForNewSignals };
