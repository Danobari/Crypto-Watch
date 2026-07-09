import axios from 'axios';
import { getTickers24h } from '../../binance.js';
import { getCyclePhase } from '../../db.js';
import { getCBBI, cbbiPhaseLabel } from '../../cycle.js';
import { json, jsonError } from './_shared/http.mts';

// GET /api/cycle — dominancia BTC, ratio ETH/BTC, score CBBI y tu fase manual.
export default async (req) => {
  try {
    let btcDominance = null;
    try {
      const globalRes = await axios.get('https://api.coingecko.com/api/v3/global');
      btcDominance = globalRes.data.data.market_cap_percentage.btc;
    } catch (e) {
      // seguimos sin dominancia si CoinGecko falla
    }

    const tickers = await getTickers24h(['BTCUSDT', 'ETHUSDT']);
    const btc = tickers['BTCUSDT'];
    const eth = tickers['ETHUSDT'];
    const ethBtcRatio = btc && eth ? eth.price / btc.price : null;

    let cbbi = null;
    try {
      cbbi = await getCBBI();
    } catch (e) {
      // CBBI es solo informativo, seguimos sin él si falla
    }

    let signal = 'Sin datos suficientes.';
    if (btcDominance !== null && eth && btc) {
      signal =
        eth.changePercent > btc.changePercent
          ? 'ETH está ganando fuerza relativa frente a BTC en las últimas 24h — vigila si el ratio ETH/BTC sigue subiendo (posible rotación temprana).'
          : 'BTC sigue liderando en las últimas 24h — todavía no hay señal clara de rotación hacia altcoins.';
    }

    const cyclePhase = await getCyclePhase();

    return json({
      btcDominance,
      ethBtcRatio,
      btcChange24h: btc ? btc.changePercent : null,
      ethChange24h: eth ? eth.changePercent : null,
      signal,
      cbbi: cbbi ? { score: cbbi.score, asOf: cbbi.asOf, label: cbbiPhaseLabel(cbbi.score) } : null,
      cyclePhase,
      altseasonIndexLink: 'https://www.blockchaincenter.net/altcoin-season-index/',
    });
  } catch (e) {
    return jsonError(e);
  }
};

export const config = {
  path: '/api/cycle',
};
