// Utilidades de ciclo de mercado: ATR (para el trailing stop dinámico) y
// el score agregado CBBI (ColinTalksCrypto Bitcoin Bull Run Index), que se
// usa solo como referencia — nunca dispara nada por sí mismo.

import axios from 'axios';

const BASE_URL = 'https://api.binance.com';

// Trae las últimas `limit` velas diarias de un símbolo (endpoint público,
// no requiere API key).
export async function getDailyKlines(symbol, limit = 30) {
  const res = await axios.get(`${BASE_URL}/api/v3/klines`, {
    params: { symbol, interval: '1d', limit },
  });
  return res.data.map((k) => ({
    openTime: k[0],
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
  }));
}

// ATR con suavizado de Wilder (el estándar de facto para trailing stops).
export function computeATR(klines, period = 14) {
  if (klines.length < period + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < klines.length; i++) {
    const { high, low } = klines[i];
    const prevClose = klines[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }

  // Semilla: promedio simple de los primeros `period` TR.
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  // Suavizado de Wilder para el resto.
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  return atr;
}

export async function getATR(symbol, period = 14) {
  const klines = await getDailyKlines(symbol, period * 2);
  return computeATR(klines, period);
}

// Multiplicador del ATR según la fase de ciclo que reporte tu análisis
// (manual, ej. el GPT de indicadores on-chain). Más ceñido en euforia /
// distribución (proteger más), más holgado en acumulación (dejar correr).
const ATR_MULTIPLIER_BY_PHASE = {
  acumulacion: 3.0,
  alcista_temprano: 2.5,
  neutral: 2.0,
  euforia: 1.5,
  distribucion: 1.2,
  bajista: 3.0,
};

export function atrMultiplierForPhase(phase) {
  return ATR_MULTIPLIER_BY_PHASE[phase] || 2.0;
}

// Los 9 indicadores individuales que componen el score agregado (nombres de
// columna confirmados contra el código fuente oficial: github.com/Zaczero/CBBI,
// metrics/*.py, propiedad `name`). Cada uno viene ya normalizado 0-1 (o 0-100
// en algunas versiones) en el JSON publicado — igual que "Confidence".
const CBBI_METRICS = [
  { key: 'PiCycle', label: 'Pi Cycle Top Indicator' },
  { key: 'RUPL', label: 'RUPL/NUPL Chart' },
  { key: 'RHODL', label: 'RHODL Ratio' },
  { key: 'Puell', label: 'Puell Multiple' },
  { key: '2YMA', label: '2 Year Moving Average' },
  { key: 'Trolololo', label: 'Bitcoin Trolololo Trend Line' },
  { key: 'MVRV', label: 'MVRV Z-Score' },
  { key: 'ReserveRisk', label: 'Reserve Risk' },
  { key: 'Woobull', label: 'Woobull Top Cap vs CVDD' },
];

// Extrae el último valor (más reciente) de una serie {timestamp: valor},
// normalizado a escala 0-100. Devuelve null si la serie no existe o está vacía.
function lastValueOf(series) {
  if (!series) return null;
  const timestamps = Object.keys(series).map(Number).sort((a, b) => a - b);
  if (!timestamps.length) return null;
  const lastTs = timestamps[timestamps.length - 1];
  let value = series[lastTs];
  if (value === null || value === undefined) return null;
  if (value <= 1) value *= 100; // algunas versiones lo publican en escala 0-1
  return { value, asOf: new Date(lastTs * 1000).toISOString() };
}

// Score CBBI agregado (0-100) + sus 9 indicadores individuales. Todo es solo
// informativo — nunca se usa para decidir nada de forma automática, solo se
// muestra en el dashboard (pestaña Ciclo de Mercado).
export async function getCBBI() {
  const res = await axios.get('https://colintalkscrypto.com/cbbi/data/latest.json', {
    timeout: 8000,
  });
  const data = res.data;

  // Busca la clave de "Confidence" sin asumir mayúsculas/minúsculas exactas,
  // por si el proyecto upstream cambia el nombre.
  const confidenceKey = Object.keys(data).find((k) => /confidence/i.test(k));
  if (!confidenceKey) return null;

  const confidence = lastValueOf(data[confidenceKey]);
  if (!confidence) return null;

  const indicators = CBBI_METRICS
    .map(({ key, label }) => {
      const last = lastValueOf(data[key]);
      if (!last) return null;
      return { key, label, value: last.value, asOf: last.asOf };
    })
    .filter(Boolean);

  return { score: confidence.value, asOf: confidence.asOf, indicators };
}

export function cbbiPhaseLabel(score) {
  if (score === null || score === undefined) return 'Sin datos';
  if (score >= 85) return 'Zona de techo de ciclo — precaución extrema';
  if (score >= 70) return 'Euforia';
  if (score >= 45) return 'Neutral / alcista';
  if (score >= 25) return 'Acumulación';
  return 'Zona de fondo de ciclo';
}
