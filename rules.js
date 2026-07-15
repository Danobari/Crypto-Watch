import { computeSMA, computeEMA, computeRSI } from './indicators.js';

export function symbolFor(coin) {
  // Asume pares contra USDT, el estándar en Binance para casi todo
  return `${coin.toUpperCase()}USDT`;
}

function describeType(rule) {
  const labels = {
    above: `sube por encima de $${rule.value}`,
    below: `baja por debajo de $${rule.value}`,
    change_up: `sube ${rule.value}% o más en 24h`,
    change_down: `baja ${rule.value}% o más en 24h`,
    sma_above: `precio cruza por encima de su media móvil simple de ${rule.value} días`,
    sma_below: `precio cae por debajo de su media móvil simple de ${rule.value} días`,
    ema_above: `precio cruza por encima de su media móvil exponencial de ${rule.value} días`,
    ema_below: `precio cae por debajo de su media móvil exponencial de ${rule.value} días`,
    rsi_above: `RSI(14) sube por encima de ${rule.value}`,
    rsi_below: `RSI(14) baja por debajo de ${rule.value}`,
    volume_above: `volumen 24h sube por encima de $${rule.value}`,
  };
  return labels[rule.type] || rule.type;
}

// Tipos de regla que necesitan el historial de cierres diarios (SMA/EMA/RSI)
// en vez de (o además de) el ticker en vivo.
const TECHNICAL_TYPES = new Set(['sma_above', 'sma_below', 'ema_above', 'ema_below', 'rsi_above', 'rsi_below']);

// Evalúa una regla contra el ticker actual (y, si aplica, el historial de
// cierres diarios para SMA/EMA/RSI — `closes`, del más viejo al más nuevo,
// o undefined si el poller todavía no tiene ese historial). Devuelve null si
// no se cumple, o un objeto con el mensaje (y la orden sugerida, si la
// regla la define).
export function evaluateRule(rule, ticker, holdingAmount, closes) {
  let hit = false;

  if (rule.type === 'above') hit = ticker.price > rule.value;
  if (rule.type === 'below') hit = ticker.price < rule.value;
  if (rule.type === 'change_up') hit = ticker.changePercent >= rule.value;
  if (rule.type === 'change_down') hit = ticker.changePercent <= -Math.abs(rule.value);
  if (rule.type === 'volume_above') hit = ticker.quoteVolume !== undefined && ticker.quoteVolume > rule.value;

  if (TECHNICAL_TYPES.has(rule.type)) {
    if (!closes) return null; // sin historial todavía (ej. poller recién arrancó) — no se puede evaluar, se reintenta en el próximo tick
    const period = Math.round(rule.value);
    if (rule.type === 'sma_above') {
      const sma = computeSMA(closes, period);
      hit = sma !== null && ticker.price > sma;
    }
    if (rule.type === 'sma_below') {
      const sma = computeSMA(closes, period);
      hit = sma !== null && ticker.price < sma;
    }
    if (rule.type === 'ema_above') {
      const ema = computeEMA(closes, period);
      hit = ema !== null && ticker.price > ema;
    }
    if (rule.type === 'ema_below') {
      const ema = computeEMA(closes, period);
      hit = ema !== null && ticker.price < ema;
    }
    if (rule.type === 'rsi_above') {
      const rsi = computeRSI(closes, 14);
      hit = rsi !== null && rsi > rule.value;
    }
    if (rule.type === 'rsi_below') {
      const rsi = computeRSI(closes, 14);
      hit = rsi !== null && rsi < rule.value;
    }
  }

  if (!hit) return null;

  const result = {
    coin: rule.coin,
    message: `${rule.coin} ${describeType(rule)} — precio actual $${ticker.price.toFixed(2)} (24h ${ticker.changePercent.toFixed(2)}%)`,
  };

  if (rule.order) {
    let qty = 0;
    if (rule.order.sizeType === 'usd') qty = rule.order.sizeValue / ticker.price;
    if (rule.order.sizeType === 'qty') qty = rule.order.sizeValue;
    if (rule.order.sizeType === 'pct_holding') qty = holdingAmount * (rule.order.sizeValue / 100);
    result.order = {
      side: rule.order.side,
      symbol: symbolFor(rule.coin),
      quantity: qty,
      referencePrice: ticker.price,
      approxValueUSD: qty * ticker.price,
    };
  }
  return result;
}
