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
//
// Entries can carry a direction ('long'|'short') and stop_price/target_price
// — these are what execution/positionMonitor.js watches to decide when to
// auto-close a position. Omit them and the position is placed but never
// auto-closed (same as before this was added).

const express = require('express');
const {
  placeEquityOrder,
  placeOptionOrder,
  waitForFill,
  tradingEnabled,
  resolveContract,
  closePosition,
  getExpirations,
  getStrikes,
  getQuote,
  buildOptionSymbol,
} = require('./tradierOrders');

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
    asset_class,
    occ_symbol,
    strike,
    expiration,
    option_type,
    direction,
    stop_price,
    target_price,
  }) {
    if (!pool) return null; // DB logging is best-effort; never block order flow on it
    try {
      const result = await pool.query(
        `INSERT INTO executed_orders
          (signal_id, tradier_order_id, ticker, side, quantity, order_type,
           status, tradier_env, conviction_score, error, raw_response,
           asset_class, occ_symbol, strike, expiration, option_type,
           direction, stop_price, target_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         RETURNING id`,
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
          asset_class ?? 'equity',
          occ_symbol ?? null,
          strike ?? null,
          expiration ?? null,
          option_type ?? null,
          direction ?? null,
          stop_price ?? null,
          target_price ?? null,
        ]
      );
      return result.rows[0]?.id ?? null;
    } catch (dbErr) {
      console.error('Failed to log executed_order:', dbErr);
      return null;
    }
  }

  // If signal_id is given but stop_price/target_price weren't explicitly
  // passed, pull them from the linked signal so the position still gets
  // monitored without the caller having to repeat values already on file.
  async function resolveStopTarget(signal_id, stop_price, target_price) {
    if (!pool || !signal_id || (stop_price != null && target_price != null)) {
      return { stop_price: stop_price ?? null, target_price: target_price ?? null };
    }
    try {
      const result = await pool.query(
        'SELECT stop_price, target_price FROM signals WHERE id = $1',
        [signal_id]
      );
      const row = result.rows[0];
      return {
        stop_price: stop_price ?? row?.stop_price ?? null,
        target_price: target_price ?? row?.target_price ?? null,
      };
    } catch (err) {
      console.error('Failed to look up signal stop/target:', err);
      return { stop_price: stop_price ?? null, target_price: target_price ?? null };
    }
  }

  // POST /api/execute-signal
  // Body: { symbol, side, quantity, conviction?, signal_id?,
  //         direction? ('long'|'short'), stop_price?, target_price? }
  //
  // direction/stop_price/target_price are optional — set them (or link a
  // signal_id whose signal row already has stop/target) to have
  // positionMonitor.js watch and auto-close this position later.
  router.post('/execute-signal', async (req, res) => {
    if (!tradingEnabled()) {
      return res.status(403).json({ error: 'Trading is disabled (TRADING_ENABLED != true)' });
    }

    const { symbol, side, quantity, conviction, signal_id, direction } = req.body;
    let { stop_price, target_price } = req.body;

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

    ({ stop_price, target_price } = await resolveStopTarget(signal_id, stop_price, target_price));

    try {
      const order = await placeEquityOrder({ symbol, side, quantity, type: 'market' });

      // The POST response only means "accepted" — poll for the actual
      // terminal status before treating this as a real fill.
      const { status: confirmedStatus, order: confirmedOrder } =
        order?.id != null ? await waitForFill(order.id) : { status: order?.status, order };

      await logOrder({
        signal_id,
        tradier_order_id: order?.id != null ? String(order.id) : null,
        ticker: symbol,
        side,
        quantity,
        status: confirmedStatus,
        conviction_score: conviction,
        raw_response: confirmedOrder || order,
        direction,
        stop_price,
        target_price,
      });

      res.json({ order: confirmedOrder || order, status: confirmedStatus });
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

  // POST /api/execute-option-signal
  // Body: { underlying, expiration (YYYY-MM-DD), optionType (call|put), strike,
  //         side (buy_to_open|sell_to_open|buy_to_close|sell_to_close),
  //         quantity, conviction?, signal_id?,
  //         direction? ('long'|'short'), stop_price?, target_price? }
  //
  // stop_price/target_price are UNDERLYING prices, not option premium —
  // positionMonitor.js watches the underlying, matching how signals.js /
  // resolver.js already define stop/target. See execution/README.md.
  router.post('/execute-option-signal', async (req, res) => {
    if (!tradingEnabled()) {
      return res.status(403).json({ error: 'Trading is disabled (TRADING_ENABLED != true)' });
    }

    const {
      underlying,
      expiration,
      optionType,
      strike,
      side,
      quantity,
      conviction,
      signal_id,
      direction,
    } = req.body;
    let { stop_price, target_price } = req.body;

    if (!underlying || !expiration || !optionType || !strike || !side || !quantity) {
      return res.status(400).json({
        error: 'underlying, expiration, optionType, strike, side, and quantity are required',
      });
    }

    if (conviction != null && conviction < MIN_CONVICTION) {
      await logOrder({
        signal_id,
        ticker: underlying,
        side,
        quantity,
        status: 'skipped_low_conviction',
        conviction_score: conviction,
        asset_class: 'option',
        strike,
        expiration,
        option_type: optionType,
      });
      return res.json({ skipped: true, reason: `conviction ${conviction} below threshold ${MIN_CONVICTION}` });
    }

    ({ stop_price, target_price } = await resolveStopTarget(signal_id, stop_price, target_price));

    try {
      const { order, occSymbol } = await placeOptionOrder({
        underlying,
        expiration,
        optionType,
        strike,
        side,
        quantity,
        type: 'market',
      });

      const { status: confirmedStatus, order: confirmedOrder } =
        order?.id != null ? await waitForFill(order.id) : { status: order?.status, order };

      await logOrder({
        signal_id,
        tradier_order_id: order?.id != null ? String(order.id) : null,
        ticker: underlying,
        side,
        quantity,
        status: confirmedStatus,
        conviction_score: conviction,
        raw_response: confirmedOrder || order,
        asset_class: 'option',
        occ_symbol: occSymbol,
        strike,
        expiration,
        option_type: optionType,
        direction,
        stop_price,
        target_price,
      });

      res.json({ order: confirmedOrder || order, occSymbol, status: confirmedStatus });
    } catch (err) {
      const errPayload = err.response?.data || { message: err.message };

      await logOrder({
        signal_id,
        ticker: underlying,
        side,
        quantity,
        status: 'error',
        conviction_score: conviction,
        error: JSON.stringify(errPayload),
        asset_class: 'option',
        strike,
        expiration,
        option_type: optionType,
      });

      res.status(500).json({ error: errPayload });
    }
  });

  // GET /api/resolve-contract?underlying=AAPL&direction=bull&tradeType=swing_short&pctOtm=0.025
  router.get('/resolve-contract', async (req, res) => {
    const { underlying, direction, tradeType, pctOtm } = req.query;
    if (!underlying || !direction || !tradeType) {
      return res.status(400).json({ error: 'underlying, direction, and tradeType are required' });
    }
    try {
      const resolved = await resolveContract({
        underlying,
        direction,
        tradeType,
        pctOtm: pctOtm != null ? Number(pctOtm) : undefined,
      });
      res.json(resolved);
    } catch (err) {
      const errPayload = err.response?.data || { message: err.message };
      res.status(500).json({ error: errPayload });
    }
  });

  // GET /api/option-expirations/:ticker
  // Real, live expirations from Tradier's options chain — for populating
  // a manual contract picker in the dashboard. Read-only, doesn't require
  // TRADING_ENABLED.
  router.get('/option-expirations/:ticker', async (req, res) => {
    try {
      const expirations = await getExpirations(req.params.ticker.toUpperCase());
      res.json({ ticker: req.params.ticker.toUpperCase(), expirations });
    } catch (err) {
      const errPayload = err.response?.data || { message: err.message };
      res.status(500).json({ error: errPayload });
    }
  });

  // GET /api/option-strikes/:ticker?expiration=YYYY-MM-DD
  router.get('/option-strikes/:ticker', async (req, res) => {
    const { expiration } = req.query;
    if (!expiration) {
      return res.status(400).json({ error: 'expiration query param is required' });
    }
    try {
      const strikes = await getStrikes(req.params.ticker.toUpperCase(), expiration);
      res.json({ ticker: req.params.ticker.toUpperCase(), expiration, strikes });
    } catch (err) {
      const errPayload = err.response?.data || { message: err.message };
      res.status(500).json({ error: errPayload });
    }
  });

  // GET /api/option-quote?underlying=AAPL&expiration=YYYY-MM-DD&optionType=call&strike=230
  // Live bid/ask/last for a specific contract — for showing a price before
  // placing a manual order. Builds the OCC symbol server-side (reuses the
  // same logic as everywhere else) so the frontend never has to construct
  // one itself.
  router.get('/option-quote', async (req, res) => {
    const { underlying, expiration, optionType, strike } = req.query;
    if (!underlying || !expiration || !optionType || !strike) {
      return res.status(400).json({ error: 'underlying, expiration, optionType, and strike are required' });
    }
    try {
      const occSymbol = buildOptionSymbol({ underlying, expiration, optionType, strike: Number(strike) });
      const quote = await getQuote(occSymbol);
      if (!quote) {
        return res.status(404).json({ error: 'No quote returned for this contract' });
      }
      res.json({
        occSymbol,
        last: quote.last ?? null,
        bid: quote.bid ?? null,
        ask: quote.ask ?? null,
        change: quote.change ?? null,
        changePercentage: quote.change_percentage ?? null,
        volume: quote.volume ?? null,
        openInterest: quote.open_interest ?? null,
      });
    } catch (err) {
      const errPayload = err.response?.data || { message: err.message };
      res.status(500).json({ error: errPayload });
    }
  });

  // POST /api/execute-option-signal-auto
  // Body: { underlying, direction (bull|bear), tradeType (0dte|swing_short|swing_long),
  //         side (buy_to_open|sell_to_open|buy_to_close|sell_to_close),
  //         quantity, pctOtm?, conviction?, signal_id?,
  //         stop_price?, target_price? }
  //
  // direction here doubles as call/put selection AND (mapped to long/short)
  // the monitor direction, when stop_price/target_price are provided.
  router.post('/execute-option-signal-auto', async (req, res) => {
    if (!tradingEnabled()) {
      return res.status(403).json({ error: 'Trading is disabled (TRADING_ENABLED != true)' });
    }

    const { underlying, direction, tradeType, side, quantity, pctOtm, conviction, signal_id } = req.body;
    let { stop_price, target_price } = req.body;

    if (!underlying || !direction || !tradeType || !side || !quantity) {
      return res.status(400).json({
        error: 'underlying, direction, tradeType, side, and quantity are required',
      });
    }

    if (conviction != null && conviction < MIN_CONVICTION) {
      await logOrder({
        signal_id,
        ticker: underlying,
        side,
        quantity,
        status: 'skipped_low_conviction',
        conviction_score: conviction,
        asset_class: 'option',
      });
      return res.json({ skipped: true, reason: `conviction ${conviction} below threshold ${MIN_CONVICTION}` });
    }

    ({ stop_price, target_price } = await resolveStopTarget(signal_id, stop_price, target_price));

    let resolved;
    try {
      resolved = await resolveContract({ underlying, direction, tradeType, pctOtm });
    } catch (err) {
      const errPayload = err.response?.data || { message: err.message };
      await logOrder({
        signal_id,
        ticker: underlying,
        side,
        quantity,
        status: 'error_resolving_contract',
        conviction_score: conviction,
        error: JSON.stringify(errPayload),
        asset_class: 'option',
      });
      return res.status(500).json({ error: errPayload });
    }

    const monitorDirection = direction === 'bull' ? 'long' : direction === 'bear' ? 'short' : null;

    try {
      const { order } = await placeOptionOrder({
        underlying,
        occSymbol: resolved.occSymbol,
        side,
        quantity,
        type: 'market',
      });

      const { status: confirmedStatus, order: confirmedOrder } =
        order?.id != null ? await waitForFill(order.id) : { status: order?.status, order };

      await logOrder({
        signal_id,
        tradier_order_id: order?.id != null ? String(order.id) : null,
        ticker: underlying,
        side,
        quantity,
        status: confirmedStatus,
        conviction_score: conviction,
        raw_response: confirmedOrder || order,
        asset_class: 'option',
        occ_symbol: resolved.occSymbol,
        strike: resolved.strike,
        expiration: resolved.expiration,
        option_type: resolved.optionType,
        direction: monitorDirection,
        stop_price,
        target_price,
      });

      res.json({ order: confirmedOrder || order, status: confirmedStatus, resolved });
    } catch (err) {
      const errPayload = err.response?.data || { message: err.message };

      await logOrder({
        signal_id,
        ticker: underlying,
        side,
        quantity,
        status: 'error',
        conviction_score: conviction,
        error: JSON.stringify(errPayload),
        asset_class: 'option',
        strike: resolved.strike,
        expiration: resolved.expiration,
        option_type: resolved.optionType,
      });

      res.status(500).json({ error: errPayload, resolved });
    }
  });

  // POST /api/close-position/:id
  // Manual override — closes a specific open executed_orders row right now,
  // regardless of whether stop/target has actually been hit. Useful for
  // testing the monitor's closing logic, or for an emergency manual exit.
  router.post('/close-position/:id', async (req, res) => {
    if (!tradingEnabled()) {
      return res.status(403).json({ error: 'Trading is disabled (TRADING_ENABLED != true)' });
    }
    if (!pool) {
      return res.status(503).json({ error: 'DATABASE_URL not set — position tracking disabled' });
    }

    const id = Number(req.params.id);
    try {
      const result = await pool.query('SELECT * FROM executed_orders WHERE id = $1', [id]);
      const position = result.rows[0];
      if (!position) return res.status(404).json({ error: 'position not found' });
      if (position.is_closed) return res.status(400).json({ error: 'position already closed' });
      if (position.status !== 'filled') {
        return res.status(400).json({ error: `position status is "${position.status}", not "filled" — nothing to close` });
      }

      const closeResult = await closePosition(position);

      await pool.query(
        `INSERT INTO executed_orders
          (signal_id, tradier_order_id, ticker, side, quantity, order_type,
           status, tradier_env, asset_class, occ_symbol, strike, expiration,
           option_type, close_reason)
         VALUES ($1,$2,$3,$4,$5,'market',$6,$7,$8,$9,$10,$11,$12,'manual')
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
        ]
      ).then(async (r) => {
        const closingOrderId = r.rows[0]?.id;
        await pool.query(
          `UPDATE executed_orders SET is_closed = true, closed_at = now(), closed_by_order_id = $1, close_reason = 'manual' WHERE id = $2`,
          [closingOrderId, id]
        );
      });

      res.json({ closed: true, position_id: id, close: closeResult });
    } catch (err) {
      const errPayload = err.response?.data || { message: err.message };
      res.status(500).json({ error: errPayload });
    }
  });

  // GET /api/open-positions
  // Positions currently being watched by positionMonitor.js.
  router.get('/open-positions', async (req, res) => {
    if (!pool) return res.status(503).json({ error: 'DATABASE_URL not set — position tracking disabled' });
    try {
      const result = await pool.query(
        `SELECT * FROM executed_orders WHERE is_closed = false AND status = 'filled' ORDER BY requested_at DESC`
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: 'query failed' });
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
