import 'dotenv/config';
import cron from 'node-cron';
import { getAccountBalances, getTickers24h } from './binance.js';
import { readJSON, writeJSON } from './store.js';
import { sendAlertEmail } from './notify.js';
import { evaluateRule, symbolFor } from './rules.js';
import {
  evaluateLadder,
  suggestedOrder,
  changePctFromEntry,
  shouldTrack,
  updateTrailingStop,
} from './ladder.js';
import { getATR, atrMultiplierForPhase } from './cycle.js';
import { startServer } from './server.js';

const ATR_REFRESH_MS = 12 * 60 * 60 * 1000; // recalcular ATR cada 12h como máximo

const INTERVAL = Number(process.env.CHECK_INTERVAL_MINUTES || 5);

async function tick() {
  const rules = await readJSON('rules.json', []);
  const activeRules = rules.filter((r) => r.active !== false);
  const positions = await readJSON('positions.json', []);

  if (activeRules.length === 0 && positions.length === 0) {
    console.log('Sin reglas ni posiciones — copia config/rules.example.json a data/rules.json, o define data/positions.json.');
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
  const tickers = await getTickers24h(coins.map(symbolFor));

  const triggeredState = await readJSON('triggered.json', {});
  const log = await readJSON('alerts-log.json', []);

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
      log.unshift({ ruleId: rule.id, message: body, time: new Date().toISOString() });
    } else if (!hitResult && wasTriggered) {
      triggeredState[rule.id] = false;
    }
  }

  const cyclePhase = await readJSON('cycle-phase.json', { phase: 'neutral' });
  let positionsChanged = false;

  // Escalera de toma de beneficios por posición (data/positions.json).
  for (const position of positions) {
    const ticker = tickers[symbolFor(position.coin)];
    if (!ticker) continue;
    const holding = balances.find((b) => b.asset === position.coin.toUpperCase());
    const holdingAmount = holding ? holding.free : 0;

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
        log.unshift({ ruleId: stateKey, message: body, time: new Date().toISOString() });
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
        log.unshift({ ruleId: trailKey, message: body, time: new Date().toISOString() });
      }
    }
  }

  if (positionsChanged) {
    await writeJSON('positions.json', positions);
  }

  await writeJSON('triggered.json', triggeredState);
  await writeJSON('alerts-log.json', log.slice(0, 200));
}

console.log(`crypto-watch iniciado — revisando cada ${INTERVAL} minuto(s).`);
tick();
cron.schedule(`*/${INTERVAL} * * * *`, tick);

// Levantar servidor del Dashboard
startServer();
