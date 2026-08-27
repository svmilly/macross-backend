// execution/executeRoute.js
//
// Express router for signal-driven order execution. Mount this only when
// you deliberately want the trading endpoints live — see README in this
// folder for the TRADING_ENABLED gate.
//
// Plug into macross-backend's Express app:
//   const executeRoute = require('./execution/executeRoute');
//   app.use('/api', executeRoute(pool));
//
// Every attempt (success, skip, or failure) is logged to executed_orders
// so fills can be traced back to the signal that triggered them.

const express = require('express');
const { placeEquityOrder, tradingEnabled } = require('./tradierOrders');

const MIN_CONVICTION = Number(process.env.MIN_CONVICTION_TO_TRADE || 5);

module.exports = function (pool) {
  const router = express.Router();

  async function logOrder({
    signal_id,
    tradier_order_id,
    ticker,
    side,
    quantity,
    order_type,
    status,
    conviction_score,
    error,
    raw_response,
  }) {
    if (!pool) return; // DB logging is best-effort; never block order flow on it
    try {
      await pool.query(
        `INSERT INTO executed_orders
          (signal_id, tradier_order_id, ticker, side, quantity, order_type,
           status, tradier_env, conviction_score, error, raw_response)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          signal_id ?? null,
          tradier_order_id ?? null,
          ticker,
          side,
          quantity,
          order_type ?? 'market',
          status ?? null,
          process.env.TRADIER_ENV === 'live' ? 'live' : 'sandbox',
          conviction_score ?? null,
          error ?? null,
          raw_response ? JSON.stringify(raw_response) : null,
        ]
      );
    } catch (dbErr) {
      console.error('Failed to log executed_order:', dbErr);
    }
  }

  // POST /api/execute-signal
  // Body: { symbol, side, quantity, conviction?, signal_id? }
  router.post('/execute-signal', async (req, res) => {
    if (!tradingEnabled()) {
      return res.status(403).json({ error: 'Trading is disabled (TRADING_ENABLED != true)' });
    }

    const { symbol, side, quantity, conviction, signal_id } = req.body;

    if (!symbol || !side || !quantity) {
      return res.status(400).json({ error: 'symbol, side, and quantity are required' });
    }

    if (conviction != null && conviction < MIN_CONVICTION) {
      await logOrder({
        signal_id,
        ticker: symbol,
        side,
        quantity,
        status: 'skipped_low_conviction',
        conviction_score: conviction,
      });
      return res.json({ skipped: true, reason: `conviction ${conviction} below threshold ${MIN_CONVICTION}` });
    }

    try {
      const order = await placeEquityOrder({ symbol, side, quantity, type: 'market' });

      await logOrder({
        signal_id,
        tradier_order_id: order?.id != null ? String(order.id) : null,
        ticker: symbol,
        side,
        quantity,
        status: order?.status,
        conviction_score: conviction,
        raw_response: order,
      });

      res.json({ order });
    } catch (err) {
      const errPayload = err.response?.data || { message: err.message };

      await logOrder({
        signal_id,
        ticker: symbol,
        side,
        quantity,
        status: 'error',
        conviction_score: conviction,
        error: JSON.stringify(errPayload),
      });

      res.status(500).json({ error: errPayload });
    }
  });

  // GET /api/executed-orders?signal_id=&ticker=&since=
  // Quick lookup for what's actually been sent to Tradier.
  router.get('/executed-orders', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'DATABASE_URL not set — order logging disabled' });

    const { signal_id, ticker, since } = req.query;
    const conditions = [];
    const params = [];

    if (signal_id) {
      params.push(signal_id);
      conditions.push(`signal_id = $${params.length}`);
    }
    if (ticker) {
      params.push(ticker);
      conditions.push(`ticker = $${params.length}`);
    }
    if (since) {
      params.push(since);
      conditions.push(`requested_at >= $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
      const result = await pool.query(
        `SELECT * FROM executed_orders ${where} ORDER BY requested_at DESC LIMIT 200`,
        params
      );
      res.json(result.rows);
    } catch (err) {
      console.error('Failed to fetch executed_orders:', err);
      res.status(500).json({ error: 'query failed' });
    }
  });

  return router;
};
