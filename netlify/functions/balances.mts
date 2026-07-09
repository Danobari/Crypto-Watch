import { getAccountBalances } from '../../binance.js';
import { json, jsonError } from './_shared/http.mts';

// GET /api/balances — saldos reales de Binance (solo lectura).
export default async (req) => {
  try {
    if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
      return json({ error: 'Claves de Binance no configuradas' }, 400);
    }
    const balances = await getAccountBalances(
      process.env.BINANCE_API_KEY,
      process.env.BINANCE_API_SECRET
    );
    return json(balances);
  } catch (e) {
    return jsonError(e);
  }
};

export const config = {
  path: '/api/balances',
};
