// brief/dailyBrief.js
//
// Generates a premarket "game plan" per ticker: current price vs prior
// close (the gap), top news headlines, and what contract the auto-resolver
// would pick if you traded it today. Reuses tradierOrders.js and
// finnhubNews.js rather than duplicating quote/news logic.
//
// CORE_TICKERS get auto-generated once each weekday at 9:00 AM ET and
// cached in memory. Any other ticker can be built on-demand via
// buildTickerBrief() — same content, just not cached long-term.

const { getQuote, resolveContract } = require('../execution/tradierOrders');
const { fetchCompanyNews } = require('../news/finnhubNews');

const CORE_TICKERS = ['SPY', 'QQQ', 'IWM', 'TSLA'];

let cachedBrief = null;       // { generatedAt, tickers: [...] }
let cachedBriefDateET = null; // 'YYYY-MM-DD' in America/New_York, dedupes same-day regeneration

function todayET() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()); // en-CA gives YYYY-MM-DD
}

function nowETParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: get('weekday'), // 'Mon','Tue',...
  };
}

// Build the game-plan for a single ticker. Never throws — errors are
// captured per-section so one failing piece (e.g. no news, no options
// chain for this name) doesn't blank out the rest.
async function buildTickerBrief(ticker) {
  const result = { ticker: ticker.toUpperCase() };

  try {
    const quote = await getQuote(ticker);
    if (quote && quote.last != null) {
      result.last = quote.last;
      result.prevClose = quote.prevclose ?? null;
      result.changePct =
        result.prevClose != null && result.prevClose !== 0
          ? ((quote.last - result.prevClose) / result.prevClose) * 100
          : null;
      result.open = quote.open ?? null;
      result.high = quote.high ?? null;
      result.low = quote.low ?? null;
      result.volume = quote.volume ?? null;
    } else {
      result.quoteError = 'No quote returned';
    }
  } catch (err) {
    result.quoteError = err.response?.data?.fault?.faultstring || err.message;
  }

  try {
    const articles = await fetchCompanyNews(ticker, { days: 1 });
    result.news = articles.slice(0, 3).map((a) => ({
      headline: a.headline,
      source: a.source,
      url: a.url,
      datetime: a.datetime,
    }));
  } catch (err) {
    result.newsError = err.response?.data || err.message;
  }

  // What the system would auto-trade today, in each direction — gives a
  // concrete "if this breaks bullish/bearish, here's the contract" anchor.
  try {
    const [bullish, bearish] = await Promise.all([
      resolveContract({ underlying: ticker, direction: 'bull', tradeType: 'swing_short' }),
      resolveContract({ underlying: ticker, direction: 'bear', tradeType: 'swing_short' }),
    ]);
    result.contractIdeas = {
      bullish: { occSymbol: bullish.occSymbol, strike: bullish.strike, expiration: bullish.expiration },
      bearish: { occSymbol: bearish.occSymbol, strike: bearish.strike, expiration: bearish.expiration },
    };
  } catch (err) {
    result.contractIdeasError = err.response?.data || err.message;
  }

  return result;
}

async function generateCoreBrief() {
  const tickers = await Promise.all(CORE_TICKERS.map((t) => buildTickerBrief(t)));
  cachedBrief = { generatedAt: new Date().toISOString(), tickers };
  cachedBriefDateET = todayET();
  console.log(`Premarket brief generated for ${cachedBriefDateET} (${CORE_TICKERS.join(', ')})`);
  return cachedBrief;
}

function getCachedBrief() {
  return cachedBrief;
}

// Checks every minute; generates once per weekday at/after 9:00 AM ET.
// Also catches up immediately on startup if the server (re)deployed after
// 9am and today's brief hasn't been generated yet.
function startDailyBriefScheduler() {
  const maybeGenerate = async () => {
    const { hour, minute, weekday } = nowETParts();
    const isWeekday = !['Sat', 'Sun'].includes(weekday);
    const isAtOrAfter9am = hour > 9 || (hour === 9 && minute >= 0);
    const alreadyGeneratedToday = cachedBriefDateET === todayET();

    if (isWeekday && isAtOrAfter9am && !alreadyGeneratedToday) {
      try {
        await generateCoreBrief();
      } catch (err) {
        console.error('Failed to generate premarket brief:', err.message);
      }
    }
  };

  maybeGenerate(); // catch-up check on startup
  return setInterval(maybeGenerate, 60 * 1000);
}

module.exports = {
  CORE_TICKERS,
  buildTickerBrief,
  generateCoreBrief,
  getCachedBrief,
  startDailyBriefScheduler,
};
