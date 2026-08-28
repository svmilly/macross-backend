// execution/tradierOrders.js
//
// Order-execution client for Tradier, isolated from the market-data proxy.
// Uses its own env vars so trading credentials/scope are never mixed with
// the read-only market-data client elsewhere in the app.
//
// Required env vars:
//   TRADIER_ENV               'sandbox' (default) or 'live'
//   TRADIER_TRADING_TOKEN     Tradier API access token (trading-scoped)
//   TRADIER_ACCOUNT_ID        Tradier brokerage account id
//   TRADING_ENABLED           must be exactly 'true' to allow any order calls

const axios = require('axios');

const TRADIER_BASE =
  process.env.TRADIER_ENV === 'live'
    ? 'https://api.tradier.com/v1'
    : 'https://sandbox.tradier.com/v1';

const ACCOUNT_ID = process.env.TRADIER_ACCOUNT_ID;

function tradingEnabled() {
  return process.env.TRADING_ENABLED === 'true';
}

function client() {
  if (!process.env.TRADIER_TRADING_TOKEN) {
    throw new Error('TRADIER_TRADING_TOKEN is not set');
  }
  return axios.create({
    baseURL: TRADIER_BASE,
    headers: {
      Authorization: `Bearer ${process.env.TRADIER_TRADING_TOKEN}`,
      Accept: 'application/json',
    },
  });
}

function assertTradingEnabled() {
  if (!tradingEnabled()) {
    throw new Error(
      'Trading is disabled. Set TRADING_ENABLED=true to allow live order placement.'
    );
  }
  if (!ACCOUNT_ID) {
    throw new Error('TRADIER_ACCOUNT_ID is not set');
  }
}

// Place an equity order.
// side: buy | sell | buy_to_cover | sell_short
// type: market | limit | stop | stop_limit
// duration: day | gtc
async function placeEquityOrder({
  symbol,
  side,
  quantity,
  type = 'market',
  duration = 'day',
  price,
  stop,
}) {
  assertTradingEnabled();

  const params = new URLSearchParams({
    class: 'equity',
    symbol,
    side,
    quantity: String(quantity),
    type,
    duration,
  });
  if (price != null) params.append('price', String(price));
  if (stop != null) params.append('stop', String(stop));

  const { data } = await client().post(
    `/accounts/${ACCOUNT_ID}/orders`,
    params
  );
  return data.order;
}

// Build a Tradier/OCC-format option symbol from friendly inputs.
// underlying: 'AAPL'
// expiration: 'YYYY-MM-DD' (e.g. '2026-09-18')
// optionType: 'call' | 'put'
// strike: number, e.g. 230 or 230.5
//
// OCC format: {underlying}{YYMMDD}{C|P}{strike * 1000, 8 digits}
function buildOptionSymbol({ underlying, expiration, optionType, strike }) {
  const date = new Date(expiration + 'T00:00:00Z');
  const yy = String(date.getUTCFullYear()).slice(-2);
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const cp = optionType.toLowerCase() === 'call' ? 'C' : 'P';
  const strikeInt = Math.round(strike * 1000);
  const strikeStr = String(strikeInt).padStart(8, '0');

  return `${underlying.toUpperCase()}${yy}${mm}${dd}${cp}${strikeStr}`;
}

// Place an option order.
// side: buy_to_open | sell_to_open | buy_to_close | sell_to_close
// type: market | limit | stop | stop_limit
// duration: day | gtc
//
// Pass either occSymbol directly, or underlying/expiration/optionType/strike
// and it'll be built for you.
async function placeOptionOrder({
  underlying,
  occSymbol,
  expiration,
  optionType,
  strike,
  side,
  quantity,
  type = 'market',
  duration = 'day',
  price,
  stop,
}) {
  assertTradingEnabled();

  const symbol = underlying.toUpperCase();
  const resolvedOccSymbol =
    occSymbol || buildOptionSymbol({ underlying, expiration, optionType, strike });

  const params = new URLSearchParams({
    class: 'option',
    symbol,
    option_symbol: resolvedOccSymbol,
    side,
    quantity: String(quantity),
    type,
    duration,
  });
  if (price != null) params.append('price', String(price));
  if (stop != null) params.append('stop', String(stop));

  const { data } = await client().post(
    `/accounts/${ACCOUNT_ID}/orders`,
    params
  );
  return { order: data.order, occSymbol: resolvedOccSymbol };
}

async function getOrderStatus(orderId) {
  assertTradingEnabled();
  const { data } = await client().get(
    `/accounts/${ACCOUNT_ID}/orders/${orderId}`
  );
  return data.order;
}

// Poll an order until it reaches a terminal status (filled, rejected,
// canceled, expired) or the attempt budget runs out. Tradier's initial
// POST response only means "accepted", not "filled" — this is what
// actually confirms whether a position exists before anything downstream
// (like a close order) assumes it does.
//
// Returns { status, order } where status is the final observed status
// string (which may still be 'pending'/'open' if it never resolved
// within the attempt budget — that is NOT the same as filled).
const TERMINAL_STATUSES = new Set(['filled', 'rejected', 'canceled', 'expired']);

async function waitForFill(orderId, { attempts = 5, delayMs = 1000 } = {}) {
  let lastOrder = null;
  for (let i = 0; i < attempts; i++) {
    lastOrder = await getOrderStatus(orderId);
    if (lastOrder && TERMINAL_STATUSES.has(lastOrder.status)) {
      return { status: lastOrder.status, order: lastOrder };
    }
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return { status: lastOrder?.status || 'unknown', order: lastOrder };
}

async function cancelOrder(orderId) {
  assertTradingEnabled();
  const { data } = await client().delete(
    `/accounts/${ACCOUNT_ID}/orders/${orderId}`
  );
  return data.order;
}

// ── Options chain lookups (read-only market data) ───────────────────────────
// These do NOT require TRADING_ENABLED — they're just data lookups, useful
// for previewing what a signal would trade before actually placing an order.
// They do still require a valid TRADIER_TRADING_TOKEN (or whichever token
// is configured) since Tradier's market-data endpoints need an API key too.

async function getQuote(symbol) {
  const { data } = await client().get('/markets/quotes', {
    params: { symbols: symbol.toUpperCase() },
  });
  const q = data?.quotes?.quote;
  // Tradier returns an object for a single symbol, an array for multiple.
  return Array.isArray(q) ? q[0] : q;
}

async function getExpirations(symbol) {
  const { data } = await client().get('/markets/options/expirations', {
    params: { symbol: symbol.toUpperCase(), includeAllRoots: true, strikes: false },
  });
  const dates = data?.expirations?.date;
  if (!dates) return [];
  return Array.isArray(dates) ? dates : [dates];
}

async function getStrikes(symbol, expiration) {
  const { data } = await client().get('/markets/options/strikes', {
    params: { symbol: symbol.toUpperCase(), expiration },
  });
  const strikes = data?.strikes?.strike;
  if (!strikes) return [];
  return Array.isArray(strikes) ? strikes : [strikes];
}

function daysBetween(dateStr) {
  const target = new Date(dateStr + 'T00:00:00Z');
  const today = new Date();
  const todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((target.getTime() - todayUTC) / 86400000);
}

// Pick the expiration closest to a target days-to-expiration, from the
// underlying's actual listed expirations. targetDays=0 for 0DTE.
function pickExpirationByDTE(expirations, targetDays) {
  if (!expirations.length) return null;
  let best = expirations[0];
  let bestDiff = Infinity;
  for (const exp of expirations) {
    const dte = daysBetween(exp);
    if (dte < 0) continue; // skip expired dates if the API ever returns any
    const diff = Math.abs(dte - targetDays);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = exp;
    }
  }
  return best;
}

// Pick the listed strike closest to spot * (1 ± pctOtm), OTM in the
// direction implied by optionType (calls OTM = above spot, puts OTM = below).
function pickStrikeByPctOtm(strikes, spot, optionType, pctOtm) {
  if (!strikes.length) return null;
  const direction = optionType.toLowerCase() === 'call' ? 1 : -1;
  const target = spot * (1 + direction * pctOtm);
  let best = strikes[0];
  let bestDiff = Infinity;
  for (const s of strikes) {
    const diff = Math.abs(s - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  return best;
}

// TRADE_TYPE_DTE maps a trade type to a target days-to-expiration. Tune here
// if your DTE targets change — everything else derives from this.
const TRADE_TYPE_DTE = {
  '0dte': 0,
  swing_short: 10,  // ~7-14 DTE band
  swing_long: 35,   // ~30-45 DTE band
};

// Resolve a full contract (expiration, strike, occSymbol) from a
// high-level trade description, using live data from Tradier's options
// chain — so the picked strike/expiration always correspond to an actual
// tradeable contract, not a computed value that might not exist.
//
// direction: 'bull' | 'bear'  →  optionType 'call' | 'put'
// tradeType: '0dte' | 'swing_short' | 'swing_long'
// pctOtm: fraction, e.g. 0.025 for 2.5% OTM (default)
async function resolveContract({ underlying, direction, tradeType, pctOtm = 0.025 }) {
  if (!TRADE_TYPE_DTE.hasOwnProperty(tradeType)) {
    throw new Error(`Unknown tradeType "${tradeType}" — expected one of: ${Object.keys(TRADE_TYPE_DTE).join(', ')}`);
  }
  const optionType = direction === 'bull' ? 'call' : 'put';
  const targetDays = TRADE_TYPE_DTE[tradeType];

  const [quote, expirations] = await Promise.all([
    getQuote(underlying),
    getExpirations(underlying),
  ]);

  if (!quote || quote.last == null) {
    throw new Error(`Could not get a live quote for ${underlying}`);
  }
  if (!expirations.length) {
    throw new Error(`No listed option expirations found for ${underlying}`);
  }

  const expiration = pickExpirationByDTE(expirations, targetDays);
  const actualDTE = daysBetween(expiration);

  // Flag when 0DTE was requested but nothing expiring today/very soon exists
  // (common for names without daily-listed options — most non-SPY/QQQ names).
  const zeroDteUnavailable = tradeType === '0dte' && actualDTE > 1;

  const strikes = await getStrikes(underlying, expiration);
  if (!strikes.length) {
    throw new Error(`No listed strikes found for ${underlying} exp ${expiration}`);
  }
  const strike = pickStrikeByPctOtm(strikes, quote.last, optionType, pctOtm);
  const occSymbol = buildOptionSymbol({ underlying, expiration, optionType, strike });

  return {
    underlying: underlying.toUpperCase(),
    optionType,
    expiration,
    actualDTE,
    strike,
    occSymbol,
    spotPrice: quote.last,
    pctOtm,
    tradeType,
    zeroDteUnavailable,
  };
}

module.exports = {
  tradingEnabled,
  placeEquityOrder,
  placeOptionOrder,
  buildOptionSymbol,
  getOrderStatus,
  waitForFill,
  cancelOrder,
  getQuote,
  getExpirations,
  getStrikes,
  resolveContract,
};
