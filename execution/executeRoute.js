// execution/executeRoute.js
//
// Express router for signal-driven order execution. Mount this only when
// you deliberately want the trading endpoints live — see README in this
// folder for the TRADING_ENABLED gate.

const express = require('express');
const { placeEquityOrder, tradingEnabled } = require('./tradierOrders');

const router = express.Router();

// Minimum conviction score (from the MA-crossover screener) required
// before a signal is allowed to generate a real order.
const MIN_CONVICTION = Number(process.env.MIN_CONVICTION_TO_TRADE || 5);

router.post('/execute-signal', async (req, res) => {
  if (!tradingEnabled()) {
    return res.status(403).json({ error: 'Trading is disabled (TRADING_ENABLED != true)' });
  }

  const { symbol, side, quantity, conviction } = req.body;

  if (!symbol || !side || !quantity) {
    return res.status(400).json({ error: 'symbol, side, and quantity are required' });
  }

  if (conviction != null && conviction < MIN_CONVICTION) {
    return res.json({ skipped: true, reason: `conviction ${conviction} below threshold ${MIN_CONVICTION}` });
  }

  try {
    const order = await placeEquityOrder({
      symbol,
      side,
      quantity,
      type: 'market',
    });
    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

module.exports = router;
