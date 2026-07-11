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

// "Ganancia no tomada": cuánto valía la posición en su pico registrado desde
// la entrada, comparado con su valor actual. peakPriceSinceEntry se guarda
// en la posición (ver index.js tick()) y arranca desde hoy — no reconstruye
// picos pasados que no se guardaron antes de activar esta función. Se usa
// tanto en /api/portfolio (dashboard) como en el sync del Google Sheet, para
// que ambos muestren el mismo número.
export function opportunityCost(position, currentPrice, holdingAmount) {
  const peakPriceSinceEntry = position.peakPriceSinceEntry ?? position.entryPrice;
  if (currentPrice === null || currentPrice === undefined || peakPriceSinceEntry <= currentPrice) {
    return { peakPriceSinceEntry, gananciaNoTomadaUSD: 0, gananciaNoTomadaPct: 0 };
  }
  return {
    peakPriceSinceEntry,
    gananciaNoTomadaUSD: holdingAmount * (peakPriceSinceEntry - currentPrice),
    gananciaNoTomadaPct: ((peakPriceSinceEntry - currentPrice) / peakPriceSinceEntry) * 100,
  };
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

// Precio objetivo en dólares para un nivel de la escalera — pura
// aritmética (precio de entrada × el % del nivel), no un pronóstico de
// mercado. Es lo que le muestra al usuario "vende cuando llegue a $X" en
// vez de obligarlo a calcular el % mentalmente.
export function targetPriceForLevel(entryPrice, level) {
  if (!entryPrice || !level) return null;
  return entryPrice * (1 + level.pct / 100);
}

function formatTargetPrice(price) {
  if (price === null || price === undefined) return '';
  const decimals = price < 1 ? 6 : price < 100 ? 4 : 2;
  return `$${price.toLocaleString('en-US', { maximumFractionDigits: decimals })}`;
}

// Texto de "Próxima Acción" para mostrar en el dashboard y en el Google
// Sheet — incluye el precio objetivo en dólares del próximo nivel, para no
// tener que calcularlo aparte.
export function nextActionText(position, changePct) {
  const level = nextPendingLevel(position);
  if (!level) return 'Todos los niveles gestionados — vigilar con trailing stop.';
  if (changePct === null) return 'Sin precio de referencia.';
  const objetivo = formatTargetPrice(targetPriceForLevel(position.entryPrice, level));
  if (changePct >= level.pct) {
    return level.sellPct > 0
      ? `Vender ~${level.sellPct}% (nivel +${level.pct}%, objetivo ${objetivo})`
      : level.action || `Nivel +${level.pct}% alcanzado (objetivo ${objetivo}) — revisar contexto.`;
  }
  const falta = (level.pct - changePct).toFixed(1);
  return `Esperar — faltan ${falta} pts para nivel +${level.pct}% (objetivo ${objetivo})`;
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
