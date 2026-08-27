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

async function getOrderStatus(orderId) {
  assertTradingEnabled();
  const { data } = await client().get(
    `/accounts/${ACCOUNT_ID}/orders/${orderId}`
  );
  return data.order;
}

async function cancelOrder(orderId) {
  assertTradingEnabled();
  const { data } = await client().delete(
    `/accounts/${ACCOUNT_ID}/orders/${orderId}`
  );
  return data.order;
}

module.exports = {
  tradingEnabled,
  placeEquityOrder,
  getOrderStatus,
  cancelOrder,
};
