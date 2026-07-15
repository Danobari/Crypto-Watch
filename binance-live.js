// Llamadas REALES a la API de Binance — solo las usa
// scripts/binance-local-poller.mjs, corriendo en tu computadora (tu IP de
// casa). El servidor en Render nunca importa este archivo: su IP compartida
// está bloqueada por Binance (confirmado con scripts/test-binance-local.mjs),
// así que en Render solo se lee lo que este poller deja guardado en
// Supabase (ver binance.js y db.js:getBinanceSnapshot).

import axios from 'axios';
import crypto from 'crypto';

const BASE_URL = 'https://api.binance.com';

function sign(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

function logRateLimitHeaders(headers, label) {
  if (!headers) return;
  const usedWeight = headers['x-mbx-used-weight-1m'];
  if (usedWeight !== undefined) {
    console.log(`   [peso] ${label} — ${usedWeight}/1200 usado en el último minuto`);
  }
}

// Saldos reales de la cuenta (solo lectura — la API key no tiene permiso de
// trading ni de retiros).
export async function fetchAccountBalances(apiKey, apiSecret) {
  const timestamp = Date.now();
  const query = `timestamp=${timestamp}&recvWindow=5000`;
  const signature = sign(query, apiSecret);
  const url = `${BASE_URL}/api/v3/account?${query}&signature=${signature}`;
  const res = await axios.get(url, { headers: { 'X-MBX-APIKEY': apiKey } });
  logRateLimitHeaders(res.headers, 'balances');
  return res.data.balances
    .map((b) => ({ asset: b.asset, free: parseFloat(b.free), locked: parseFloat(b.locked) }))
    .filter((b) => b.free + b.locked > 0);
}

function tickerFromRow(t) {
  return {
    symbol: t.symbol,
    price: parseFloat(t.lastPrice),
    changePercent: parseFloat(t.priceChangePercent),
    // Volumen 24h en USDT (quoteVolume) — más intuitivo para un umbral en $
    // que el volumen en unidades de la moneda (volume).
    quoteVolume: parseFloat(t.quoteVolume),
  };
}

// Cierres de velas diarias (endpoint público, sin límite de peso fuerte) —
// usado para calcular SMA/EMA/RSI en Reglas. `limit` cierres más recientes,
// del más viejo al más nuevo.
export async function fetchDailyCloses(symbol, limit = 210) {
  const res = await axios.get(`${BASE_URL}/api/v3/klines`, {
    params: { symbol, interval: '1d', limit },
  });
  logRateLimitHeaders(res.headers, `klines(${symbol})`);
  return res.data.map((k) => parseFloat(k[4])); // k[4] = close
}

// Precio y cambio 24h de varios símbolos a la vez (endpoint público). Si
// algún símbolo no existe en Binance (ej. un saldo de un producto que no
// se tradea, o un typo en una regla), el request agrupado falla ENTERO —
// por eso, si eso pasa, se reintenta uno por uno y se descartan solo los
// que de verdad fallan, en vez de perder todos los precios de ese ciclo.
export async function fetchTickers24h(symbols) {
  const unique = Array.from(new Set(symbols));
  if (unique.length === 0) return {};

  try {
    const res = await axios.get(`${BASE_URL}/api/v3/ticker/24hr`, {
      params: { symbols: JSON.stringify(unique.sort()) },
    });
    logRateLimitHeaders(res.headers, `tickers(${unique.length})`);
    const results = {};
    for (const t of res.data) results[t.symbol] = tickerFromRow(t);
    return results;
  } catch (e) {
    console.log(`   ⚠️  Falló el pedido agrupado (${e.response?.data?.msg || e.message}), reintentando uno por uno...`);
  }

  const results = {};
  for (const symbol of unique) {
    try {
      const res = await axios.get(`${BASE_URL}/api/v3/ticker/24hr`, { params: { symbol } });
      results[symbol] = tickerFromRow(res.data);
    } catch (e) {
      console.log(`   ⚠️  Se descarta ${symbol}: ${e.response?.data?.msg || e.message}`);
    }
  }
  return results;
}
