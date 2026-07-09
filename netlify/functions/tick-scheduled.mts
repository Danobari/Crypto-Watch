// Versión serverless de tick() (antes en index.js, disparado por node-cron).
// Netlify no tiene un proceso persistente: en vez de "cada N minutos desde
// que arrancó el proceso", esto corre como Scheduled Function con cron real.
// Revisa reglas + escalera de niveles + trailing stop ATR, y manda el email
// de aviso con la orden sugerida cuando algo se dispara. Nunca coloca nada
// en Binance — solo calcula y avisa.

import { getAccountBalances, getTickers24h } from '../../binance.js';
import {
  getRules,
  getPositions,
  savePositions,
  getCyclePhase,
  getTriggeredState,
  saveTriggeredState,
  appendAlert,
} from '../../db.js';
import { sendAlertEmail } from '../../notify.js';
import { evaluateRule, symbolFor } from '../../rules.js';
import { evaluateLadder, suggestedOrder, changePctFromEntry, shouldTrack, updateTrailingStop } from '../../ladder.js';
import { getATR, atrMultiplierForPhase } from '../../cycle.js';

const ATR_REFRESH_MS = 12 * 60 * 60 * 1000; // recalcular ATR cada 12h como máximo

export default async (req) => {
  const rules = await getRules();
  const activeRules = rules.filter((r) => r.active !== false);
  const positions = await getPositions();

  if (activeRules.length === 0 && positions.length === 0) {
    console.log('Sin reglas ni posiciones — nada que revisar.');
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
        await appendAlert({ ruleId: stateKey, message: body });
      }
    }

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
  console.log(`tick-scheduled completado (${new Date().toISOString()}).`);
};

// Cada 5 minutos, igual que CHECK_INTERVAL_MINUTES por defecto en local.
// Netlify Scheduled Functions solo corren en despliegues publicados, no en
// deploy previews.
export const config = {
  schedule: '*/5 * * * *',
};
