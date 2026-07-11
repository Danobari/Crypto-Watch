import 'dotenv/config';
import axios from 'axios';
import cron from 'node-cron';
import { getAccountBalances, getTickers24h } from './binance.js';
import {
  getRules,
  getPositions,
  savePositions,
  getCyclePhase,
  getTriggeredState,
  saveTriggeredState,
  getAlertsLog,
  appendAlert,
} from './db.js';
import { sendAlertEmail } from './notify.js';
import { evaluateRule, symbolFor } from './rules.js';
import {
  evaluateLadder,
  suggestedOrder,
  changePctFromEntry,
  shouldTrack,
  updateTrailingStop,
  nextPendingLevel,
  pctSold,
  nextActionText,
  opportunityCost,
} from './ladder.js';
import { getATR, atrMultiplierForPhase, getCBBI, cbbiPhaseLabel } from './cycle.js';
import { syncTrackerSheets } from './sheets-sync.js';
import { startServer } from './server.js';

const ATR_REFRESH_MS = 12 * 60 * 60 * 1000; // recalcular ATR cada 12h como máximo

const INTERVAL = Number(process.env.CHECK_INTERVAL_MINUTES || 5);

// Sincroniza el Google Sheet una vez al día — se dispara desde dentro de
// tick() reusando los balances/tickers que YA se pidieron ahí mismo, en vez
// de volver a llamar a Binance por separado (eso era lo que duplicaba el
// peso de requests y ayudaba a gatillar el ban 418 en cada arranque).
let lastSheetsSyncDate = null;

async function maybeSyncSheets({ positions, rules, balances, tickers }) {
  if (!process.env.GOOGLE_SHEET_ID) return; // no configurado, se ignora en silencio
  const today = new Date().toISOString().slice(0, 10);
  if (lastSheetsSyncDate === today) return;

  try {
    let btcDominance = null;
    try {
      const globalRes = await axios.get('https://api.coingecko.com/api/v3/global', { timeout: 8000 });
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

    await syncTrackerSheets({
      positions,
      tickers,
      balances,
      symbolFor,
      helpers: { changePctFromEntry, nextPendingLevel, pctSold, nextActionText, opportunityCost },
      cycleData: { cyclePhase, btcDominance, ethBtcRatio, btcChange24h: btc?.changePercent, ethChange24h: eth?.changePercent, cbbi, signal },
      rules,
      alerts,
    });
    lastSheetsSyncDate = today;
    console.log(`Google Sheet sincronizado (${new Date().toLocaleString()}).`);
  } catch (e) {
    console.error('No se pudo sincronizar el Google Sheet:', e.message);
  }
}

async function tick() {
  const rules = await getRules();
  const activeRules = rules.filter((r) => r.active !== false);
  const positions = await getPositions();

  if (activeRules.length === 0 && positions.length === 0) {
    console.log('Sin reglas ni posiciones — agrega una regla o una posición desde el dashboard.');
    return;
  }

  let balances = [];
  try {
    if (process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET) {
      balances = await getAccountBalances(process.env.BINANCE_API_KEY, process.env.BINANCE_API_SECRET);
    }
  } catch (e) {
    console.error('No se pudieron leer los saldos de Binance:', e.message);
  }

  const coins = [...new Set([...activeRules.map((r) => r.coin), ...positions.map((p) => p.coin)])];
  let tickers = {};
  try {
    tickers = await getTickers24h(coins.map(symbolFor));
  } catch (e) {
    console.error('No se pudieron leer los tickers de Binance:', e.message);
    return; // sin precios no hay nada que evaluar en este tick — se reintenta en el próximo
  }

  const triggeredState = await getTriggeredState();

  for (const rule of activeRules) {
    const ticker = tickers[symbolFor(rule.coin)];
    if (!ticker) continue;
    const holding = balances.find((b) => b.asset === rule.coin.toUpperCase());
    const holdingAmount = holding ? holding.free : 0;

    const hitResult = evaluateRule(rule, ticker, holdingAmount);
    const wasTriggered = !!triggeredState[rule.id];

    if (hitResult && !wasTriggered) {
      triggeredState[rule.id] = true;
      let body = hitResult.message;
      if (hitResult.order) {
        const sideLabel = hitResult.order.side === 'sell' ? 'VENTA' : 'COMPRA';
        body +=
          `\n\nOrden sugerida: ${sideLabel} ${hitResult.order.quantity.toFixed(6)} ${rule.coin}` +
          ` (~$${hitResult.order.approxValueUSD.toFixed(2)}) en ${hitResult.order.symbol},` +
          ` precio referencia $${hitResult.order.referencePrice.toFixed(2)}.` +
          `\nTú decides si la colocas — esto no ejecuta nada en Binance.`;
      }
      console.log(body);
      await sendAlertEmail(`[crypto-watch] ${rule.coin} — regla disparada`, body);
      await appendAlert({ ruleId: rule.id, message: body });
    } else if (!hitResult && wasTriggered) {
      triggeredState[rule.id] = false;
    }
  }

  const cyclePhase = await getCyclePhase();
  let positionsChanged = false;

  // Escalera de toma de beneficios por posición (data/positions.json).
  for (const position of positions) {
    const ticker = tickers[symbolFor(position.coin)];
    if (!ticker) continue;
    const holding = balances.find((b) => b.asset === position.coin.toUpperCase());
    const holdingAmount = holding ? holding.free : 0;

    // Precio pico desde la entrada — para calcular "ganancia no tomada"
    // (cuánto valía la posición en su mejor momento vs. ahora). Arranca
    // desde el precio de entrada la primera vez que se ve la posición (no
    // hay forma de reconstruir picos pasados que no se guardaron antes de
    // hoy) y de ahí en adelante solo sube si el precio actual es mayor.
    const previousPeak = position.peakPriceSinceEntry ?? position.entryPrice;
    if (ticker.price > previousPeak) {
      position.peakPriceSinceEntry = ticker.price;
      positionsChanged = true;
    } else if (position.peakPriceSinceEntry === null || position.peakPriceSinceEntry === undefined) {
      position.peakPriceSinceEntry = previousPeak;
      positionsChanged = true;
    }

    const hit = evaluateLadder(position, ticker.price);
    const stateKey = `ladder:${position.coin}:${hit ? hit.level.pct : ''}`;

    if (hit) {
      const wasAlerted = !!triggeredState[stateKey];
      if (!wasAlerted) {
        triggeredState[stateKey] = true;
        const order = suggestedOrder(position.coin, holdingAmount, hit.level.sellPct, ticker.price);
        let body =
          `${position.coin} alcanzó +${hit.level.pct}% desde tu entrada de $${position.entryPrice}` +
          ` (precio actual $${ticker.price.toFixed(4)}, ganancia ${hit.changePct.toFixed(1)}%).`;
        if (hit.level.sellPct > 0) {
          body +=
            `\n\nOrden sugerida: VENTA ${order.quantity.toFixed(6)} ${position.coin}` +
            ` (~$${order.approxValueUSD.toFixed(2)}) en ${order.symbol}, precio referencia $${order.referencePrice.toFixed(2)}.` +
            `\nAbrir en Binance: ${order.binanceLink}` +
            `\nTú decides si la colocas y a qué precio — esto no ejecuta nada en Binance.` +
            `\nMarca el nivel como vendido desde el dashboard (pestaña Cartera) una vez la coloques.`;
        } else {
          body += `\n\n${hit.level.action || 'Revisar contexto antes de decidir.'}`;
        }
        console.log(body);
        await sendAlertEmail(`[crypto-watch] ${position.coin} — nivel +${hit.level.pct}% alcanzado`, body);
        await appendAlert({ ruleId: stateKey, message: body });
      }
    }

    // Trailing stop dinámico (ATR) — solo se activa una vez el precio cruza
    // el último nivel de la escalera (zona de "no vender automático").
    const changePct = changePctFromEntry(position.entryPrice, ticker.price);
    if (shouldTrack(position, changePct) && !(position.trailingStop && position.trailingStop.triggered)) {
      const needsATR =
        !position.trailingStop ||
        !position.trailingStop.atrUpdatedAt ||
        Date.now() - new Date(position.trailingStop.atrUpdatedAt).getTime() > ATR_REFRESH_MS;

      let atr = position.trailingStop ? position.trailingStop.atr : null;
      if (needsATR) {
        try {
          atr = await getATR(symbolFor(position.coin));
        } catch (e) {
          console.error(`No se pudo calcular ATR de ${position.coin}:`, e.message);
        }
      }

      const multiplier = atrMultiplierForPhase(cyclePhase.phase);
      const { trailingStop, justTriggered } = updateTrailingStop(position, ticker.price, atr, multiplier);
      trailingStop.atrUpdatedAt = needsATR ? new Date().toISOString() : (position.trailingStop ? position.trailingStop.atrUpdatedAt : null);
      position.trailingStop = trailingStop;
      positionsChanged = true;

      const trailKey = `trail:${position.coin}`;
      if (justTriggered && !triggeredState[trailKey]) {
        triggeredState[trailKey] = true;
        const sellPct = position.trailingSellPct || 100;
        const order = suggestedOrder(position.coin, holdingAmount, sellPct, ticker.price);
        const body =
          `${position.coin} rompió su trailing stop dinámico: precio actual $${ticker.price.toFixed(4)},` +
          ` máximo reciente $${trailingStop.peakPrice.toFixed(4)}, stop en $${trailingStop.stopPrice.toFixed(4)}` +
          ` (ATR14 x${multiplier}).` +
          `\n\nOrden sugerida: VENTA ${order.quantity.toFixed(6)} ${position.coin}` +
          ` (~$${order.approxValueUSD.toFixed(2)}) en ${order.symbol}, precio referencia $${order.referencePrice.toFixed(2)}.` +
          `\nAbrir en Binance: ${order.binanceLink}` +
          `\nTú decides si la colocas y a qué precio — esto no ejecuta nada en Binance.`;
        console.log(body);
        await sendAlertEmail(`[crypto-watch] ${position.coin} — trailing stop disparado`, body);
        await appendAlert({ ruleId: trailKey, message: body });
      }
    }
  }

  if (positionsChanged) {
    await savePositions(positions);
  }

  await saveTriggeredState(triggeredState);

  // Google Sheet: una vez al día, reusando los balances/tickers que ya se
  // pidieron arriba (sin llamadas extra a Binance).
  await maybeSyncSheets({ positions, rules, balances, tickers });
}

// Nunca dejar que un error dentro de tick() tumbe todo el proceso (eso hacía
// que Render marcara el deploy como fallido y siguiera sirviendo la versión
// vieja — justo lo que pasó con el ban 418: tick() lanzaba un error sin
// capturar y crasheaba el servicio en cada arranque).
async function safeTick() {
  try {
    await tick();
  } catch (e) {
    console.error('tick() falló (no se detiene el servicio):', e.message);
  }
}

process.on('unhandledRejection', (e) => {
  console.error('unhandledRejection (ignorado, el servicio sigue corriendo):', e?.message || e);
});

console.log(`crypto-watch iniciado — revisando cada ${INTERVAL} minuto(s).`);
safeTick();
cron.schedule(`*/${INTERVAL} * * * *`, safeTick);

// Levantar servidor del Dashboard
startServer();
