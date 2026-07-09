import { getAccountBalances, getTickers24h } from '../../binance.js';
import { getPositions } from '../../db.js';
import { symbolFor } from '../../rules.js';
import { evaluateLadder, nextPendingLevel, pctSold, nextActionText, changePctFromEntry } from '../../ladder.js';
import { json, jsonError } from './_shared/http.mts';

// GET /api/portfolio — cartera con P&L calculado en vivo.
export default async (req) => {
  try {
    const positions = await getPositions();
    let balances = [];
    if (process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET) {
      try {
        balances = await getAccountBalances(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET);
      } catch (e) {
        // seguimos sin saldos si Binance falla
      }
    }
    const symbols = positions.map((p) => symbolFor(p.coin));
    const tickers = await getTickers24h(symbols);

    const rows = positions.map((p) => {
      const ticker = tickers[symbolFor(p.coin)];
      const holding = balances.find((b) => b.asset === p.coin.toUpperCase());
      const holdingAmount = holding ? holding.free + holding.locked : 0;
      const currentPrice = ticker ? ticker.price : null;
      const changePct = currentPrice !== null ? changePctFromEntry(p.entryPrice, currentPrice) : null;
      const valorActual = currentPrice !== null ? holdingAmount * currentPrice : null;
      const pending = nextPendingLevel(p);
      const hit = currentPrice !== null ? evaluateLadder(p, currentPrice) : null;

      return {
        coin: p.coin,
        block: p.block,
        notes: p.notes || '',
        entryPrice: p.entryPrice,
        currentPrice,
        changePct,
        holdingAmount,
        valorActual,
        levels: p.levels.map((l) => ({
          ...l,
          precioObjetivo: p.entryPrice * (1 + l.pct / 100),
        })),
        pctVendido: pctSold(p),
        proximaAccion: currentPrice !== null ? nextActionText(p, changePct) : 'Sin precio de referencia',
        nivelCruzadoPendiente: hit ? { pct: hit.level.pct, levelIndex: hit.levelIndex } : null,
        pendienteInfo: pending ? { pct: pending.pct, sellPct: pending.sellPct } : null,
        trailingStop: p.trailingStop || null,
      };
    });

    return json(rows);
  } catch (e) {
    return jsonError(e);
  }
};

export const config = {
  path: '/api/portfolio',
};
