// Motor de la "escalera" de toma de beneficios.
//
// Cada posición (data/positions.json) tiene un precio de entrada y una
// lista de niveles (+40%, +80%, +120%, etc., según el bloque). Este módulo
// solo hace la aritmética: cuánto ha subido el precio desde la entrada, y
// si eso cruza el próximo nivel todavía no marcado como vendido.
//
// No decide nada por su cuenta y no coloca órdenes — solo calcula.

export function changePctFromEntry(entryPrice, currentPrice) {
  if (!entryPrice) return null;
  return ((currentPrice - entryPrice) / entryPrice) * 100;
}

// Devuelve el próximo nivel no vendido (el de menor % que falte), o null
// si ya se marcaron todos como vendidos.
export function nextPendingLevel(position) {
  const pending = position.levels.filter((l) => !l.sold);
  if (pending.length === 0) return null;
  return pending.reduce((a, b) => (a.pct < b.pct ? a : b));
}

// Evalúa si el precio actual cruza el próximo nivel pendiente.
// Devuelve { changePct, level, levelIndex } si se cruzó, o null si no.
export function evaluateLadder(position, currentPrice) {
  const changePct = changePctFromEntry(position.entryPrice, currentPrice);
  if (changePct === null) return null;

  const level = nextPendingLevel(position);
  if (!level) return null;

  if (changePct >= level.pct) {
    const levelIndex = position.levels.findIndex((l) => l === level);
    return { changePct, level, levelIndex };
  }
  return null;
}

// Calcula la orden sugerida para vender una fracción (sellPct) de la
// posición actual. holdingAmount = saldo real leído de Binance.
export function suggestedOrder(coin, holdingAmount, sellPct, currentPrice) {
  const quantity = holdingAmount * (sellPct / 100);
  return {
    side: 'sell',
    symbol: `${coin.toUpperCase()}USDT`,
    quantity,
    referencePrice: currentPrice,
    approxValueUSD: quantity * currentPrice,
    binanceLink: `https://www.binance.com/en/trade/${coin.toUpperCase()}_USDT?type=spot`,
  };
}

// % ya vendido acumulado de una posición (suma de sellPct de niveles con sold=true).
export function pctSold(position) {
  return position.levels.filter((l) => l.sold).reduce((sum, l) => sum + (l.sellPct || 0), 0);
}

// Texto de "Próxima Acción" para mostrar en el dashboard.
export function nextActionText(position, changePct) {
  const level = nextPendingLevel(position);
  if (!level) return 'Todos los niveles gestionados — vigilar con trailing stop.';
  if (changePct === null) return 'Sin precio de referencia.';
  if (changePct >= level.pct) {
    return level.sellPct > 0
      ? `Vender ~${level.sellPct}% (nivel +${level.pct}%)`
      : level.action || `Nivel +${level.pct}% alcanzado — revisar contexto.`;
  }
  const falta = (level.pct - changePct).toFixed(1);
  return `Esperar — faltan ${falta} pts para nivel +${level.pct}%`;
}

// --- Trailing stop dinámico (ATR) ---
//
// Se arma cuando el precio cruza el último nivel de la escalera (el que
// tiene sellPct 0 — la zona de "no vender automático, evaluar trailing
// stop"). A partir de ahí, cada tick actualiza el máximo (peak) visto y
// calcula el precio de stop = peak - ATR * multiplicador. El multiplicador
// depende de la fase de ciclo (más ceñido en euforia, más holgado en
// acumulación) — ver cycle.js.
//
// No vende nada por su cuenta: solo calcula y avisa una vez cuando el
// precio actual cae por debajo del stop.

export function topLevel(position) {
  return position.levels[position.levels.length - 1];
}

// Decide si ya toca armar/actualizar el trailing stop: el precio debe haber
// cruzado el pct del último nivel.
export function shouldTrack(position, changePct) {
  if (changePct === null) return false;
  return changePct >= topLevel(position).pct;
}

// Actualiza (o inicializa) el estado de trailing stop de una posición.
// Devuelve el nuevo objeto trailingStop y si se disparó en este tick.
export function updateTrailingStop(position, currentPrice, atr, multiplier) {
  const existing = position.trailingStop || { armed: false, peakPrice: null, triggered: false };

  if (existing.triggered) {
    // Ya se avisó una vez; no seguir recalculando hasta que se reinicie.
    return { trailingStop: existing, justTriggered: false };
  }

  const peakPrice = existing.armed ? Math.max(existing.peakPrice, currentPrice) : currentPrice;
  const stopPrice = atr !== null && atr !== undefined ? peakPrice - atr * multiplier : null;
  const hit = stopPrice !== null && currentPrice <= stopPrice;

  const trailingStop = {
    armed: true,
    peakPrice,
    atr,
    multiplier,
    stopPrice,
    triggered: hit,
    updatedAt: new Date().toISOString(),
  };

  return { trailingStop, justTriggered: hit };
}

export function resetTrailingStop(position) {
  return { armed: false, peakPrice: null, atr: null, multiplier: null, stopPrice: null, triggered: false };
}
