// Indicadores técnicos — funciones puras de aritmética sobre un arreglo de
// precios de cierre diarios (closes[0] = el más viejo, closes[last] = hoy).
// No llaman a Binance ni a ningún API — eso lo hace binance-live.js (poller)
// o cycle.js (klines). Aquí solo se calcula, igual que ladder.js con la
// escalera de niveles.

// Media móvil simple (SMA): promedio de los últimos `period` cierres.
export function computeSMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(closes.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// Media móvil exponencial (EMA): da más peso a los precios recientes que la
// SMA. Semilla = SMA de los primeros `period` valores, luego se suaviza con
// el factor estándar 2/(period+1).
export function computeEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// RSI (Relative Strength Index) con suavizado de Wilder — el mismo método
// que ya usa cycle.js para el ATR del trailing stop. 0-100: por convención,
// >70 se lee como "sobrecomprado", <30 como "sobrevendido", pero eso es
// solo una referencia — la regla que arme el usuario decide el umbral real.
export function computeRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;

  const gains = [];
  const losses = [];
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains.push(Math.max(change, 0));
    losses.push(Math.max(-change, 0));
  }

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
