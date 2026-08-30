// brief/briefRoute.js
//
// GET /api/premarket-brief          — cached core-ticker brief (SPY/QQQ/IWM/TSLA),
//                                      auto-generated at 9am ET on weekdays
// GET /api/premarket-brief?force=1  — force-regenerate the core brief right now
// GET /api/premarket-brief/:ticker  — on-demand game plan for any ticker

const express = require('express');
const { buildTickerBrief, generateCoreBrief, getCachedBrief } = require('./dailyBrief');

module.exports = function () {
  const router = express.Router();

  router.get('/premarket-brief', async (req, res) => {
    if (req.query.force) {
      try {
        const fresh = await generateCoreBrief();
        return res.json(fresh);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }
    const cached = getCachedBrief();
    if (!cached) {
      return res.json({ generated: false, message: 'Not generated yet today — check back at/after 9:00 AM ET, or add ?force=1 to generate now.' });
    }
    res.json(cached);
  });

  router.get('/premarket-brief/:ticker', async (req, res) => {
    try {
      const brief = await buildTickerBrief(req.params.ticker);
      res.json(brief);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
