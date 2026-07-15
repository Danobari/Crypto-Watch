// Este archivo YA NO llama a Binance directamente.
//
// Confirmado con scripts/test-binance-local.mjs: la IP compartida de Render
// está bloqueada por Binance (ban tras ban, sin importar cuánto se
// optimizara el código), mientras que la IP de casa de Daniel funciona
// perfecto. La solución: scripts/binance-local-poller.mjs corre en su
// computadora cada 5 minutos, llama a Binance de verdad (ver
// binance-live.js) y guarda el resultado en Supabase (tabla
// binance_snapshot). Este archivo, usado por index.js y server.js en
// Render, solo LEE ese snapshot — misma forma de datos que antes
// (getAccountBalances, getTicker24h, getTickers24h), para no tener que
// tocar el resto del código.
//
// Si tu computadora está apagada o el poller no corre, los datos se van
// quedando viejos — pasados 15 minutos sin actualizarse, estas funciones
// lanzan un error claro en vez de mostrar números desactualizados en
// silencio.

import { getBinanceSnapshot, getTechnicalSnapshot } from './db.js';

const STALE_MS = 15 * 60 * 1000; // 15 min — generoso sobre el ciclo de 5 min del poller

function staleError(label, updatedAt) {
  if (!updatedAt) {
    return new Error(
      `${label}: tu computadora todavía no ha mandado ningún dato. Revisa que scripts/binance-local-poller.mjs esté corriendo (ver README).`
    );
  }
  const mins = Math.round((Date.now() - new Date(updatedAt).getTime()) / 60000);
  return new Error(
    `${label}: el último dato es de hace ${mins} min — revisa que tu computadora esté encendida y el poller corriendo.`
  );
}

// Saldos reales de tu cuenta, leídos del último snapshot que dejó el
// poller local. Los parámetros quedan solo por compatibilidad con el resto
// del código (ya no se usan aquí — la API key la usa binance-live.js en tu
// computadora).
export async function getAccountBalances(_apiKey, _apiSecret) {
  const snap = await getBinanceSnapshot();
  if (!snap.balancesUpdatedAt || Date.now() - new Date(snap.balancesUpdatedAt).getTime() > STALE_MS) {
    throw staleError('Saldos de Binance', snap.balancesUpdatedAt);
  }
  return snap.balances;
}

// Precio y cambio 24h de un símbolo, leído del snapshot.
export async function getTicker24h(symbol) {
  const all = await getTickers24h([symbol]);
  return all[symbol];
}

// Precio y cambio 24h de varios símbolos, leído del snapshot.
export async function getTickers24h(symbols) {
  const snap = await getBinanceSnapshot();
  if (!snap.tickersUpdatedAt || Date.now() - new Date(snap.tickersUpdatedAt).getTime() > STALE_MS) {
    throw staleError('Precios de Binance', snap.tickersUpdatedAt);
  }
  const unique = Array.from(new Set(symbols));
  const results = {};
  for (const symbol of unique) {
    if (snap.tickers[symbol]) results[symbol] = snap.tickers[symbol];
  }
  return results;
}

// Cierres diarios por moneda (para SMA/EMA/RSI en Reglas). Solo trae las
// monedas que ya haya guardado el poller (ej. no todas las reglas tienen
// historial todavía en su primer ciclo) — quien llame decide qué hacer si
// falta una moneda (mismo criterio que getTickers24h con símbolos ausentes).
export async function getTechnicalCloses(coins) {
  const snap = await getTechnicalSnapshot();
  if (!snap.updatedAt || Date.now() - new Date(snap.updatedAt).getTime() > STALE_MS) {
    throw staleError('Indicadores técnicos', snap.updatedAt);
  }
  const results = {};
  for (const coin of coins) {
    const key = coin.toUpperCase();
    if (snap.closes[key]) results[key] = snap.closes[key];
  }
  return results;
}
