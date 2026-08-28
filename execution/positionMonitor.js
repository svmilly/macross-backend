// execution/positionMonitor.js
//
// Watches open positions (executed_orders rows where is_closed=false and
// status='filled') against their stop_price/target_price and closes them
// automatically when hit.
//
// IMPORTANT — how stop/target are checked for OPTIONS:
// stop_price/target_price are UNDERLYING prices (matching signals.js /
// resolver.js convention), not option premium. This monitor checks the
// underlying's current quote against those levels, then closes the OPTION
// position when hit — it does NOT track the option's own premium/P&L.
// A signal's stop/target were picked based on the underlying's technicals,
// so this keeps the exit logic consistent with how the signal was defined.
//
// Only 'long' and 'short' directions are monitored. A position with no
// direction set (or missing stop_price/target_price) is left alone —
// nothing closes it automatically; same as before this module existed.
//
// Runs on an interval; does NOT check market hours — a check that fires
// outside market hours will just see stale/last-close quotes and is
// unlikely to spuriously trigger a stop/target hit, but this hasn't been
// stress-tested against that scenario. Treat off-hours behavior as
// unverified.

const { getQuote, closePosition, tradingEnabled } = require('./tradierOrders');

let monitorInFlight = false;

function checkHit(position, currentPrice) {
  const { direction, stop_price, target_price } = position;
  if (!direction || (stop_price == null && target_price == null)) return null;

  if (direction === 'long') {
    if (stop_price != null && currentPrice <= stop_price) return 'stop';
    if (target_price != null && currentPrice >= target_price) return 'target';
  } else if (direction === 'short') {
    if (stop_price != null && currentPrice >= stop_price) return 'stop';
    if (target_price != null && currentPrice <= target_price) return 'target';
  }
  return null;
}

async function checkAndCloseOpenPositions(pool) {
  if (!pool || monitorInFlight) return;
  monitorInFlight = true;
  try {
    const result = await pool.query(
      `SELECT * FROM executed_orders
       WHERE is_closed = false AND status = 'filled'
         AND direction IS NOT NULL
         AND (stop_price IS NOT NULL OR target_price IS NOT NULL)`
    );

    for (const position of result.rows) {
      try {
        // Stop/target are underlying-price based for both equities and
        // options — always quote the underlying ticker, never the OCC symbol.
        const quote = await getQuote(position.ticker);
        if (!quote || quote.last == null) continue;

        const hitReason = checkHit(position, quote.last);
        if (!hitReason) continue;

        if (!tradingEnabled()) {
          console.warn(
            `Position ${position.id} (${position.ticker}) hit its ${hitReason} but TRADING_ENABLED is false — not closing.`
          );
          continue;
        }

        console.log(`Position ${position.id} (${position.ticker}) hit ${hitReason} at ${quote.last} — closing.`);
        const closeResult = await closePosition(position);

        const insertResult = await pool.query(
          `INSERT INTO executed_orders
            (signal_id, tradier_order_id, ticker, side, quantity, order_type,
             status, tradier_env, asset_class, occ_symbol, strike, expiration,
             option_type, close_reason)
           VALUES ($1,$2,$3,$4,$5,'market',$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING id`,
          [
            position.signal_id,
            closeResult.tradierOrderId,
            position.ticker,
            closeResult.side,
            position.quantity,
            closeResult.status,
            process.env.TRADIER_ENV === 'live' ? 'live' : 'sandbox',
            position.asset_class,
            position.occ_symbol,
            position.strike,
            position.expiration,
            position.option_type,
            hitReason,
          ]
        );
        const closingOrderId = insertResult.rows[0]?.id;

        await pool.query(
          `UPDATE executed_orders
           SET is_closed = true, closed_at = now(), closed_by_order_id = $1, close_reason = $2
           WHERE id = $3`,
          [closingOrderId, hitReason, position.id]
        );
      } catch (err) {
        console.error(`Failed to check/close position ${position.id}:`, err.message);
        // Leave this position open and move on — don't let one bad
        // ticker/quote failure stop the rest of the monitor cycle.
      }
    }
  } catch (err) {
    console.error('positionMonitor cycle failed:', err.message);
  } finally {
    monitorInFlight = false;
  }
}

function startPositionMonitor(pool, { intervalMs = 60 * 1000 } = {}) {
  checkAndCloseOpenPositions(pool);
  return setInterval(() => checkAndCloseOpenPositions(pool), intervalMs);
}

module.exports = { startPositionMonitor, checkAndCloseOpenPositions };
