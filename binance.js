import axios from 'axios';
import crypto from 'crypto';

const BASE_URL = 'https://api.binance.com';

function sign(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

// --- Freno de emergencia (circuit breaker) ---
// Binance banea temporalmente la IP (HTTP 418) o limita (429) si se manda
// demasiado peso de requests en poco tiempo. Sin este freno, cada vez que el
// servicio "despierta" (plan gratis de Render duerme tras inactividad) el
// código reintenta de inmediato en cada ruta/tick, lo que insiste contra un
// ban activo — y potencialmente lo renueva o lo alarga. Mientras el freno
// esté activo, ni siquiera se manda el request: se falla localmente y rápido.
let bannedUntil = 0;

function isBanned() {
  return Date.now() < bannedUntil;
}

function registerBan(e) {
  const status = e.response?.status;
  if (status !== 418 && status !== 429) return;

  // Binance normalmente incluye el epoch (ms) hasta el que dura el ban en el
  // mensaje de error, ej: "IP banned until 1499827319053". Si no lo trae, se
  // usa un enfriamiento conservador por defecto.
  const msg = e.response?.data?.msg || '';
  const match = msg.match(/banned until (\d+)/i);
  const fallbackMs = status === 418 ? 5 * 60 * 1000 : 30 * 1000; // 5 min / 30s
  const until = match ? Number(match[1]) : Date.now() + fallbackMs;

  bannedUntil = Math.max(bannedUntil, until);
  const mins = Math.ceil((bannedUntil - Date.now()) / 60000);
  console.error(`Binance ${status === 418 ? 'baneó' : 'limitó'} esta IP — pausando llamadas ~${mins} min (hasta ${new Date(bannedUntil).toISOString()}).`);
}

function bannedError() {
  const mins = Math.ceil((bannedUntil - Date.now()) / 60000);
  return new Error(`Binance temporalmente bloqueado (ban activo, ~${mins} min restantes) — no se reintenta hasta que expire.`);
}

// --- Caché corta ---
// Varias rutas del dashboard (cartera, mercado, ciclo) y el tick de fondo
// piden los mismos tickers/saldos casi al mismo tiempo. Cachear unos
// segundos evita mandar el mismo request varias veces en la misma ráfaga.
const CACHE_TTL_MS = 15_000;
const tickersCache = new Map(); // key: symbols ordenados -> { data, at }
let balancesCache = null; // { data, at }

// Lee los saldos reales de tu cuenta. Requiere una API key con permiso de
// Lectura únicamente — este endpoint solo lee, nunca escribe ni ejecuta nada.
export async function getAccountBalances(apiKey, apiSecret) {
  if (isBanned()) throw bannedError();
  if (balancesCache && Date.now() - balancesCache.at < CACHE_TTL_MS) {
    return balancesCache.data;
  }

  const timestamp = Date.now();
  const query = `timestamp=${timestamp}&recvWindow=5000`;
  const signature = sign(query, apiSecret);
  const url = `${BASE_URL}/api/v3/account?${query}&signature=${signature}`;
  try {
    const res = await axios.get(url, { headers: { 'X-MBX-APIKEY': apiKey } });
    const data = res.data.balances
      .map((b) => ({ asset: b.asset, free: parseFloat(b.free), locked: parseFloat(b.locked) }))
      .filter((b) => b.free + b.locked > 0);
    balancesCache = { data, at: Date.now() };
    return data;
  } catch (e) {
    registerBan(e);
    throw e;
  }
}

// Precio y cambio 24h de un símbolo (endpoint público, no requiere API key).
export async function getTicker24h(symbol) {
  if (isBanned()) throw bannedError();
  try {
    const res = await axios.get(`${BASE_URL}/api/v3/ticker/24hr`, { params: { symbol } });
    return {
      symbol: res.data.symbol,
      price: parseFloat(res.data.lastPrice),
      changePercent: parseFloat(res.data.priceChangePercent),
    };
  } catch (e) {
    registerBan(e);
    throw e;
  }
}

// Precio y cambio 24h de varios símbolos a la vez (un solo request agrupado
// en vez de uno por moneda) — reduce el peso/weight consumido en la API de
// Binance y evita bans temporales (HTTP 418) por ráfagas de requests, algo
// que pasa fácilmente cuando el servicio "despierta" en un plan gratuito y
// dispara varias rutas (cartera, mercado, ciclo) casi al mismo tiempo.
export async function getTickers24h(symbols) {
  const results = {};
  const unique = Array.from(new Set(symbols)).sort();
  if (unique.length === 0) return results;

  const cacheKey = unique.join(',');
  const cached = tickersCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.data;
  }

  if (isBanned()) throw bannedError();

  try {
    const res = await axios.get(`${BASE_URL}/api/v3/ticker/24hr`, {
      params: { symbols: JSON.stringify(unique) },
    });
    for (const t of res.data) {
      results[t.symbol] = {
        symbol: t.symbol,
        price: parseFloat(t.lastPrice),
        changePercent: parseFloat(t.priceChangePercent),
      };
    }
    tickersCache.set(cacheKey, { data: results, at: Date.now() });
    return results;
  } catch (e) {
    registerBan(e);
    console.error('No se pudo leer tickers agrupados, se intenta uno por uno:', e.message);
  }

  // Fallback: si el request agrupado falla (ej. algún símbolo inválido, y no
  // por un ban ya registrado arriba), se intenta uno por uno para no perder
  // los que sí son válidos.
  if (isBanned()) throw bannedError();
  for (const symbol of unique) {
    try {
      results[symbol] = await getTicker24h(symbol);
    } catch (e) {
      console.error(`No se pudo leer ${symbol}:`, e.message);
      if (isBanned()) break; // ya no sigas insistiendo si se acaba de banear
    }
  }
  tickersCache.set(cacheKey, { data: results, at: Date.now() });
  return results;
}
