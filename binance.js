import axios from 'axios';
import crypto from 'crypto';
import { getBinanceBanUntil, saveBinanceBanUntil } from './db.js';

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
//
// El estado se persiste en Supabase (tabla binance_ban_state) además de en
// memoria: si el proceso viviera solo en memoria y Render lo reinicia
// (crash, redeploy, o el propio ciclo del plan gratis) mientras el ban
// sigue activo en Binance, la variable en memoria se resetearía a 0 y la
// app volvería a mandar un request real contra un ban que Binance todavía
// tiene activo — y Binance, al detectar la insistencia, lo extiende (así
// fue como un ban de ~35 min pasó a marcar ~124 min tras un reinicio).
let bannedUntil = 0;
let banStateLoadPromise = null;

function loadPersistedBanState() {
  if (!banStateLoadPromise) {
    banStateLoadPromise = getBinanceBanUntil()
      .then((persisted) => {
        if (persisted > bannedUntil) bannedUntil = persisted;
      })
      .catch((e) => {
        console.error('No se pudo leer el ban de Binance persistido en Supabase:', e.message);
      });
  }
  return banStateLoadPromise;
}

async function isBanned() {
  await loadPersistedBanState();
  return Date.now() < bannedUntil;
}

async function registerBan(e) {
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

  try {
    await saveBinanceBanUntil(bannedUntil);
  } catch (persistErr) {
    console.error('No se pudo persistir el ban de Binance en Supabase (queda solo en memoria):', persistErr.message);
  }
}

function bannedError() {
  const mins = Math.ceil((bannedUntil - Date.now()) / 60000);
  return new Error(`Binance temporalmente bloqueado (ban activo, ~${mins} min restantes) — no se reintenta hasta que expire.`);
}

// --- Visibilidad real del peso consumido ---
// Binance manda en CADA respuesta (éxito o error) el peso realmente
// consumido por esta IP en el último minuto (X-MBX-USED-WEIGHT-1M). Antes
// solo sabíamos que nos habían baneado, sin saber si de verdad estábamos
// cerca del límite (1200/min) o si el ban viene de otro lado (ej. IP
// compartida con otros clientes de Render en la misma región). Registrar
// este número en cada request da evidencia real en vez de suposiciones.
function logRateLimitHeaders(headers, label) {
  if (!headers) return;
  const usedWeight = headers['x-mbx-used-weight-1m'];
  const retryAfter = headers['retry-after'];
  if (usedWeight !== undefined) {
    console.log(
      `[Binance peso] ${label} — peso usado en el último minuto: ${usedWeight}/1200` +
        (retryAfter ? `, Retry-After: ${retryAfter}s` : '')
    );
  }
}

// --- Caché por símbolo + single-flight ---
// Antes el cache de tickers se guardaba por la combinación EXACTA de
// símbolos pedidos ("BTCUSDT,ETHUSDT" vs "ALGOUSDT,BTCUSDT,ETHUSDT,..."),
// así que cada ruta del dashboard (Cartera, Mercado, Ciclo) y el tick de
// fondo — que piden combinaciones ligeramente distintas de monedas — tenían
// cada una su propio cache y su propio request a Binance, aunque los
// símbolos se solaparan. Eso fue justo lo que volvió a disparar el ban
// apenas expiraba uno: al abrir el dashboard en ese momento, dos o tres
// rutas + el tick pedían tickers casi al mismo tiempo con distintas
// combinaciones, cada una fallando el cache de la otra.
//
// Ahora el cache es por símbolo individual (compartido entre todas las
// rutas) y además hay un "single-flight": si ya hay un request de tickers
// en curso, cualquier otra llamada simultánea espera ese mismo resultado
// en vez de mandar un request nuevo.
const CACHE_TTL_MS = 20_000;
const tickerCache = new Map(); // symbol -> { data, at }
let balancesCache = null; // { data, at }
let balancesInFlight = null;
let tickersInFlight = null; // Promise de la ronda de fetch en curso (si hay una)

// Lee los saldos reales de tu cuenta. Requiere una API key con permiso de
// Lectura únicamente — este endpoint solo lee, nunca escribe ni ejecuta nada.
export async function getAccountBalances(apiKey, apiSecret) {
  if (balancesCache && Date.now() - balancesCache.at < CACHE_TTL_MS) {
    return balancesCache.data;
  }
  if (balancesInFlight) return balancesInFlight;

  if (await isBanned()) throw bannedError();

  balancesInFlight = (async () => {
    const timestamp = Date.now();
    const query = `timestamp=${timestamp}&recvWindow=5000`;
    const signature = sign(query, apiSecret);
    const url = `${BASE_URL}/api/v3/account?${query}&signature=${signature}`;
    try {
      const res = await axios.get(url, { headers: { 'X-MBX-APIKEY': apiKey } });
      logRateLimitHeaders(res.headers, 'getAccountBalances');
      const data = res.data.balances
        .map((b) => ({ asset: b.asset, free: parseFloat(b.free), locked: parseFloat(b.locked) }))
        .filter((b) => b.free + b.locked > 0);
      balancesCache = { data, at: Date.now() };
      return data;
    } catch (e) {
      logRateLimitHeaders(e.response?.headers, 'getAccountBalances (error)');
      await registerBan(e);
      throw e;
    }
  })();

  try {
    return await balancesInFlight;
  } finally {
    balancesInFlight = null;
  }
}

// Precio y cambio 24h de un símbolo (endpoint público, no requiere API key).
export async function getTicker24h(symbol) {
  const cached = tickerCache.get(symbol);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  if (await isBanned()) throw bannedError();
  try {
    const res = await axios.get(`${BASE_URL}/api/v3/ticker/24hr`, { params: { symbol } });
    logRateLimitHeaders(res.headers, `getTicker24h(${symbol})`);
    const data = {
      symbol: res.data.symbol,
      price: parseFloat(res.data.lastPrice),
      changePercent: parseFloat(res.data.priceChangePercent),
    };
    tickerCache.set(symbol, { data, at: Date.now() });
    return data;
  } catch (e) {
    logRateLimitHeaders(e.response?.headers, `getTicker24h(${symbol}) (error)`);
    await registerBan(e);
    throw e;
  }
}

// Precio y cambio 24h de varios símbolos a la vez. El cache es por símbolo
// individual (no por la combinación pedida), así que da igual si Cartera,
// Mercado, Ciclo y el tick de fondo piden combinaciones distintas: los
// símbolos que ya se pidieron hace poco (por cualquiera de ellos) se sirven
// del cache, y solo se manda UN request agrupado por los que de verdad
// faltan.
export async function getTickers24h(symbols) {
  const unique = Array.from(new Set(symbols));
  if (unique.length === 0) return {};

  const now = Date.now();
  const results = {};
  let stale = [];
  for (const symbol of unique) {
    const cached = tickerCache.get(symbol);
    if (cached && now - cached.at < CACHE_TTL_MS) {
      results[symbol] = cached.data;
    } else {
      stale.push(symbol);
    }
  }
  if (stale.length === 0) return results;

  // Single-flight: si ya hay una ronda de fetch en curso, esperarla y
  // volver a mirar el cache en vez de mandar otro request en paralelo.
  if (tickersInFlight) {
    await tickersInFlight.catch(() => {});
    return getTickers24h(symbols);
  }

  if (await isBanned()) {
    if (Object.keys(results).length > 0) return results; // mejor datos parciales que nada
    throw bannedError();
  }

  tickersInFlight = (async () => {
    try {
      const res = await axios.get(`${BASE_URL}/api/v3/ticker/24hr`, {
        params: { symbols: JSON.stringify(stale.sort()) },
      });
      logRateLimitHeaders(res.headers, `getTickers24h(${stale.length} símbolos)`);
      for (const t of res.data) {
        const data = {
          symbol: t.symbol,
          price: parseFloat(t.lastPrice),
          changePercent: parseFloat(t.priceChangePercent),
        };
        tickerCache.set(t.symbol, { data, at: Date.now() });
      }
    } catch (e) {
      logRateLimitHeaders(e.response?.headers, 'getTickers24h agrupado (error)');
      await registerBan(e);
      console.error('No se pudo leer tickers agrupados, se intenta uno por uno:', e.message);

      // Fallback: si el request agrupado falla y no fue por un ban (ej.
      // algún símbolo inválido), se intenta uno por uno para no perder los
      // que sí son válidos.
      if (!(await isBanned())) {
        for (const symbol of stale) {
          try {
            await getTicker24h(symbol);
          } catch (err) {
            console.error(`No se pudo leer ${symbol}:`, err.message);
            if (await isBanned()) break;
          }
        }
      }
    }
  })();

  try {
    await tickersInFlight;
  } finally {
    tickersInFlight = null;
  }

  for (const symbol of stale) {
    const cached = tickerCache.get(symbol);
    if (cached) results[symbol] = cached.data;
  }
  return results;
}
