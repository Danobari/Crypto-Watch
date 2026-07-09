import { getAccountBalances, getTickers24h } from '../../binance.js';
import { getRules } from '../../db.js';
import { json, jsonError } from './_shared/http.mts';

// GET /api/market — precio y cambio 24h de las monedas en tus reglas/saldos.
export default async (req) => {
  try {
    const rules = await getRules();
    let balances = [];
    if (process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET) {
      try {
        balances = await getAccountBalances(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET);
      } catch (e) {
        // sin saldos, seguimos solo con precios
      }
    }
    const coins = new Set([...rules.map((r) => r.coin), ...balances.map((b) => b.asset)]);
    coins.delete('USDT');
    const symbols = Array.from(coins).map((c) => `${c}USDT`);
    const tickers = await getTickers24h(symbols);

    const marketData = Array.from(coins)
      .map((coin) => {
        const ticker = tickers[`${coin}USDT`];
        return {
          coin,
          price: ticker ? ticker.price : null,
          changePercent: ticker ? ticker.changePercent : null,
        };
      })
      .filter((d) => d.price !== null);

    return json(marketData);
  } catch (e) {
    return jsonError(e);
  }
};

export const config = {
  path: '/api/market',
};
