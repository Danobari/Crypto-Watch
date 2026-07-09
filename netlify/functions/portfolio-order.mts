import { getAccountBalances, getTickers24h } from '../../binance.js';
import { getPosition } from '../../db.js';
import { symbolFor } from '../../rules.js';
import { suggestedOrder } from '../../ladder.js';
import { json, jsonError } from './_shared/http.mts';

// GET /api/portfolio/:coin/order/:levelIndex — prepara la orden de un nivel (no ejecuta nada).
export default async (req, context) => {
  try {
    const { coin, levelIndex } = context.params;
    const position = await getPosition(coin);
    if (!position) return json({ error: 'Posición no encontrada' }, 404);
    const level = position.levels[Number(levelIndex)];
    if (!level) return json({ error: 'Nivel no encontrado' }, 404);

    let balances = [];
    if (process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET) {
      try {
        balances = await getAccountBalances(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET);
      } catch (e) {
        // seguimos sin saldos si Binance falla
      }
    }
    const holding = balances.find((b) => b.asset === position.coin.toUpperCase());
    const holdingAmount = holding ? holding.free + holding.locked : 0;

    const tickers = await getTickers24h([symbolFor(position.coin)]);
    const ticker = tickers[symbolFor(position.coin)];
    if (!ticker) return json({ error: 'No se pudo leer el precio actual' }, 500);

    const order = suggestedOrder(position.coin, holdingAmount, level.sellPct, ticker.price);
    return json({ ...order, level, taxReserveSugerida: order.approxValueUSD * 0.3 });
  } catch (e) {
    return jsonError(e);
  }
};

export const config = {
  path: '/api/portfolio/:coin/order/:levelIndex',
};
