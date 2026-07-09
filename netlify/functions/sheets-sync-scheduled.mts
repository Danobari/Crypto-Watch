// Versión serverless de la sincronización de Tracker (antes excel-sync.js +
// syncExcel() en index.js, que editaban un .xlsx local — incompatible con
// Netlify porque no hay disco persistente entre invocaciones). Esta función
// arma el mismo panorama completo (Cartera, Ciclo de Mercado, Reglas,
// Historial de Alertas) y lo escribe en el Google Sheet vía sheets-sync.js.
// Es puramente informativa — nunca coloca nada en Binance.

import axios from 'axios';
import { getAccountBalances, getTickers24h } from '../../binance.js';
import { getPositions, getRules, getCyclePhase, getAlertsLog } from '../../db.js';
import { symbolFor } from '../../rules.js';
import { changePctFromEntry, nextPendingLevel, pctSold, nextActionText } from '../../ladder.js';
import { getCBBI, cbbiPhaseLabel } from '../../cycle.js';
import { syncTrackerSheets } from '../../sheets-sync.js';

export default async (req) => {
  const positions = await getPositions();
  const rules = await getRules();

  let balances = [];
  try {
    if (process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET) {
      balances = await getAccountBalances(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET);
    }
  } catch (e) {
    console.error('No se pudieron leer los saldos de Binance para el sync de Sheets:', e.message);
  }

  const coins = [...new Set(positions.map((p) => p.coin))];
  const tickers = await getTickers24h([...coins.map(symbolFor), 'BTCUSDT', 'ETHUSDT']);

  // Mismo cálculo que /api/cycle en server.js / cycle.mts.
  let btcDominance = null;
  try {
    const globalRes = await axios.get('https://api.coingecko.com/api/v3/global');
    btcDominance = globalRes.data.data.market_cap_percentage.btc;
  } catch (e) {
    console.error('No se pudo leer dominancia BTC de CoinGecko:', e.message);
  }

  const btc = tickers['BTCUSDT'];
  const eth = tickers['ETHUSDT'];
  const ethBtcRatio = btc && eth ? eth.price / btc.price : null;

  let cbbi = null;
  try {
    const raw = await getCBBI();
    if (raw) cbbi = { score: raw.score, asOf: raw.asOf, label: cbbiPhaseLabel(raw.score) };
  } catch (e) {
    console.error('No se pudo leer CBBI:', e.message);
  }

  let signal = 'Sin datos suficientes.';
  if (btcDominance !== null && eth && btc) {
    signal =
      eth.changePercent > btc.changePercent
        ? 'ETH está ganando fuerza relativa frente a BTC en las últimas 24h — vigila si el ratio ETH/BTC sigue subiendo.'
        : 'BTC sigue liderando en las últimas 24h — todavía no hay señal clara de rotación hacia altcoins.';
  }

  const cyclePhase = await getCyclePhase();
  const alerts = await getAlertsLog(200);

  try {
    await syncTrackerSheets({
      positions,
      tickers,
      balances,
      symbolFor,
      helpers: { changePctFromEntry, nextPendingLevel, pctSold, nextActionText },
      cycleData: { cyclePhase, btcDominance, ethBtcRatio, btcChange24h: btc?.changePercent, ethChange24h: eth?.changePercent, cbbi, signal },
      rules,
      alerts,
    });
    console.log(`Google Sheet sincronizado (${new Date().toISOString()}).`);
  } catch (e) {
    console.error('No se pudo sincronizar el Google Sheet:', e.message);
  }
};

// Una vez al día, igual que el sync de Tracker.xlsx original (hora UTC —
// ajusta la expresión si quieres otra hora local).
export const config = {
  schedule: '0 14 * * *',
};
