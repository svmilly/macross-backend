// routes/signals.js
// Plug into your existing macross-backend Express app:
//   const signalsRouter = require('./routes/signals');
//   app.use('/api/signals', signalsRouter(pool));

const express = require('express');

module.exports = function (pool) {
  const router = express.Router();

  // POST /api/signals
  // Call this wherever your screener currently fires/displays a signal.
  // Stop/target let the resolver compute R-multiples; if you don't have
  // explicit stop/target logic yet, pass a fixed R (e.g. 1% stop / 2% target)
  // and compute stop_price/target_price before calling this.
  router.post('/', async (req, res) => {
    const {
      ticker,
      setup_type,
      conviction_score,
      direction,
      entry_price,
      or_high,
      or_low,
      or_window_minutes,
      stop_price,
      target_price,
      tf,
    } = req.body;

    if (!ticker || !setup_type || !direction || !entry_price) {
      return res.status(400).json({
        error: 'ticker, setup_type, direction, and entry_price are required',
      });
    }

    try {
      const result = await pool.query(
        `INSERT INTO signals
          (ticker, setup_type, conviction_score, direction, entry_price,
           or_high, or_low, or_window_minutes, stop_price, target_price, tf)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          ticker,
          setup_type,
          conviction_score ?? null,
          direction,
          entry_price,
          or_high ?? null,
          or_low ?? null,
          or_window_minutes ?? null,
          stop_price ?? null,
          target_price ?? null,
          tf ?? null,
        ]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error('Failed to log signal:', err);
      res.status(500).json({ error: 'insert failed' });
    }
  });

  // GET /api/signals/stats
  // Win rate, avg R, expectancy grouped by setup_type (and optionally direction).
  // Query params: ?setup_type=orb  ?ticker=SPY  ?since=2026-01-01
  router.get('/stats', async (req, res) => {
    const { setup_type, ticker, since, group_by_direction } = req.query;

    const conditions = [`outcome IS NOT NULL`];
    const params = [];

    if (setup_type) {
      params.push(setup_type);
      conditions.push(`setup_type = $${params.length}`);
    }
    if (ticker) {
      params.push(ticker);
      conditions.push(`ticker = $${params.length}`);
    }
    if (since) {
      params.push(since);
      conditions.push(`entry_time >= $${params.length}`);
    }

    const groupCols = group_by_direction === 'true'
      ? 'setup_type, direction'
      : 'setup_type';

    const query = `
      SELECT
        ${groupCols},
        COUNT(*) AS total_signals,
        COUNT(*) FILTER (WHERE outcome = 'win') AS wins,
        COUNT(*) FILTER (WHERE outcome = 'loss') AS losses,
        COUNT(*) FILTER (WHERE outcome = 'scratch') AS scratches,
        ROUND(
          COUNT(*) FILTER (WHERE outcome = 'win')::NUMERIC
          / NULLIF(COUNT(*) FILTER (WHERE outcome IN ('win','loss')), 0) * 100,
          1
        ) AS win_rate_pct,
        ROUND(AVG(r_multiple), 2) AS avg_r_multiple,
        ROUND(SUM(r_multiple), 2) AS total_r
      FROM signals
      WHERE ${conditions.join(' AND ')}
      GROUP BY ${groupCols}
      ORDER BY total_r DESC NULLS LAST
    `;

    try {
      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (err) {
      console.error('Failed to fetch stats:', err);
      res.status(500).json({ error: 'query failed' });
    }
  });

  return router;
};
