import { getAccountBalances, getTickers24h } from '../../binance.js';
import { getPosition } from '../../db.js';
import { symbolFor } from '../../rules.js';
import { suggestedOrder } from '../../ladder.js';
import { json, jsonError } from './_shared/http.mts';

// GET /api/portfolio/:coin/trailing-order — prepara la orden de salida por trailing stop.
export default async (req, context) => {
  try {
    const { coin } = context.params;
    const position = await getPosition(coin);
    if (!position) return json({ error: 'Posición no encontrada' }, 404);
    if (!position.trailingStop || !position.trailingStop.triggered) {
      return json({ error: 'El trailing stop de esta posición todavía no se ha disparado' }, 400);
    }

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

    const sellPct = position.trailingSellPct || 100;
    const order = suggestedOrder(position.coin, holdingAmount, sellPct, ticker.price);
    return json({ ...order, trailingStop: position.trailingStop, taxReserveSugerida: order.approxValueUSD * 0.3 });
  } catch (e) {
    return jsonError(e);
  }
};

export const config = {
  path: '/api/portfolio/:coin/trailing-order',
};
